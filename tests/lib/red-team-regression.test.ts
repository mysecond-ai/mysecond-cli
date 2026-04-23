// Regression tests for the 6 red-team findings on PR 4c.
// Each test ENCODES the bug so a future refactor that removes the fix fails.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let fakeHome: string;
let originalHome: string | undefined;
let originalProjectDir: string | undefined;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'mysecond-redteam-'));
  originalHome = process.env.HOME;
  originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
  process.env.HOME = fakeHome;
  delete process.env.CLAUDE_PROJECT_DIR;
  vi.resetModules();
});

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  if (originalProjectDir !== undefined) process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
  rmSync(fakeHome, { recursive: true, force: true });
});

// =====================================================================
// P0-2: slug validation prevents path traversal
// =====================================================================
describe('RED-TEAM P0-2: slug validation', () => {
  it('rejects slug containing path-traversal sequence', async () => {
    const { validateSlug } = await import('../../src/lib/mysecond-paths.js');
    expect(() => validateSlug('../../etc')).toThrow(/Invalid customer slug format/);
    expect(() => validateSlug('foo/bar')).toThrow(/Invalid customer slug format/);
    expect(() => validateSlug('foo\\bar')).toThrow(/Invalid customer slug format/);
  });

  it('rejects empty slug, non-string slug, slug exceeding 64 chars', async () => {
    const { validateSlug } = await import('../../src/lib/mysecond-paths.js');
    expect(() => validateSlug('')).toThrow();
    expect(() => validateSlug(null as unknown)).toThrow(/not a string/);
    expect(() => validateSlug(123 as unknown)).toThrow(/not a string/);
    expect(() => validateSlug('a'.repeat(65))).toThrow(/Invalid customer slug format/);
  });

  it('accepts realistic customer slugs', async () => {
    const { validateSlug } = await import('../../src/lib/mysecond-paths.js');
    expect(validateSlug('acme-corp-a3f2')).toBe('acme-corp-a3f2');
    expect(validateSlug('tenant_001')).toBe('tenant_001');
    expect(validateSlug('UPPER-case-OK')).toBe('UPPER-case-OK');
  });

  it('error message does not echo the malicious slug verbatim (defense-in-depth)', async () => {
    const { validateSlug } = await import('../../src/lib/mysecond-paths.js');
    let caught: Error | null = null;
    try {
      validateSlug('$(rm -rf /)');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).not.toContain('$(rm');
    // Length is OK to surface — it's diagnostic but not echoing shell metachars.
    expect(caught!.message).toContain('length=');
  });
});

// =====================================================================
// P0-3: wrong-window detection no longer passes for every Mac user
// =====================================================================
describe('RED-TEAM P0-3: wrong-window walk-up does NOT match ~/.claude', () => {
  it('returns false when ~/.claude/ is the only .claude dir found (Mac CC user in iTerm2)', async () => {
    // Set up the failing scenario: ~/.claude/ exists (Claude Code Desktop is
    // installed), customer is in a regular terminal at /tmp/work/myproject
    // with no .claude/ in that tree. Pre-fix: walk-up reaches HOME, finds
    // ~/.claude/, returns true → wrong-window check passes incorrectly.
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    const projectDir = join(fakeHome, 'work', 'myproject');
    mkdirSync(projectDir, { recursive: true });

    const { isInClaudeCodeContext } = await import('../../src/lib/paste-detect.js');
    expect(isInClaudeCodeContext(projectDir)).toBe(false);
  });

  it('returns true when project-level .claude/ exists (real Claude Code workspace)', async () => {
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    const projectDir = join(fakeHome, 'work', 'myproject');
    mkdirSync(join(projectDir, '.claude'), { recursive: true });

    const { isInClaudeCodeContext } = await import('../../src/lib/paste-detect.js');
    expect(isInClaudeCodeContext(projectDir)).toBe(true);
  });

  it('returns true when CLAUDE_PROJECT_DIR env var is set (fast path unaffected)', async () => {
    process.env.CLAUDE_PROJECT_DIR = '/some/path';
    const { isInClaudeCodeContext } = await import('../../src/lib/paste-detect.js');
    expect(isInClaudeCodeContext('/anywhere')).toBe(true);
  });
});

// =====================================================================
// P1-3: LKG cache re-validates tree fingerprint on read
// =====================================================================
describe('RED-TEAM P1-3: LKG cache rejects tampered/corrupted tree on read', () => {
  it('returns hit on intact cache', async () => {
    const mod = await import('../../src/lib/last-known-good.js');
    const src = join(fakeHome, 'src-plugin');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'manifest.json'), '{"name":"pm-os"}');
    writeFileSync(join(src, 'README.md'), 'hi');

    mod.cacheLastKnownGood('acme', '1.0.0', 'sha256-fake', src);
    expect(mod.findLastKnownGood('acme')).not.toBeNull();
  });

  it('returns null on cache when a file was added after caching (tampered)', async () => {
    const mod = await import('../../src/lib/last-known-good.js');
    const src = join(fakeHome, 'src-plugin');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'manifest.json'), '{"name":"pm-os"}');

    mod.cacheLastKnownGood('acme', '1.0.0', 'sha256-fake', src);
    const hit = mod.findLastKnownGood('acme')!;
    // Tamper: add a file to the cached tree.
    writeFileSync(join(hit.source_dir, 'evil.sh'), '#!/bin/sh\nrm -rf /');
    expect(mod.findLastKnownGood('acme')).toBeNull();
  });

  it('returns null on cache when a file was deleted after caching', async () => {
    const mod = await import('../../src/lib/last-known-good.js');
    const src = join(fakeHome, 'src-plugin');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'a.txt'), '1');
    writeFileSync(join(src, 'b.txt'), '2');

    mod.cacheLastKnownGood('acme', '1.0.0', 'sha256-fake', src);
    const hit = mod.findLastKnownGood('acme')!;
    rmSync(join(hit.source_dir, 'b.txt'));
    expect(mod.findLastKnownGood('acme')).toBeNull();
  });

  it('accepts pre-P1-3 cache entries without tree_fingerprint (back-compat)', async () => {
    const mod = await import('../../src/lib/last-known-good.js');
    const { lastKnownGoodIndexPath, lastKnownGoodVersionDir } = await import(
      '../../src/lib/mysecond-paths.js'
    );

    // Hand-write a legacy cache entry without tree_fingerprint.
    const dir = lastKnownGoodVersionDir('acme', '0.9.0');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plugin.json'), '{}');

    const indexPath = lastKnownGoodIndexPath();
    mkdirSync(join(fakeHome, '.mysecond', 'cache', 'last-known-good'), { recursive: true });
    writeFileSync(
      indexPath,
      JSON.stringify({
        'customer-acme': [
          {
            version: '0.9.0',
            cached_at: '2026-01-01T00:00:00Z',
            sha256: 'legacy',
            // tree_fingerprint omitted intentionally — this is the back-compat case
          },
        ],
      })
    );

    const hit = mod.findLastKnownGood('acme');
    expect(hit).not.toBeNull();
    expect(hit!.version).toBe('0.9.0');
  });
});

// =====================================================================
// P1-2: NODE_ENV gate on injectable delay
// =====================================================================
describe('RED-TEAM P1-2: injectable delay is NODE_ENV=test gated', () => {
  it('does NOT spin-wait when NODE_ENV !== "test" (production safety)', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { coupledAtomicWrite, __setInjectableDelayBetweenRenames } = await import(
        '../../src/lib/atomic-write.js'
      );
      // Simulate a forgotten-reset scenario: production code accidentally got
      // the delay set to 5 seconds. With the NODE_ENV gate in place, the
      // delay should NOT actually fire.
      __setInjectableDelayBetweenRenames(5_000);
      const a = join(fakeHome, 'a.txt');
      const b = join(fakeHome, 'b.txt');
      const start = Date.now();
      coupledAtomicWrite([
        { path: a, content: 'aa' },
        { path: b, content: 'bb' },
      ]);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1_000); // would be ≥5000 without the gate
      __setInjectableDelayBetweenRenames(0); // reset
    } finally {
      if (originalNodeEnv !== undefined) process.env.NODE_ENV = originalNodeEnv;
      else delete process.env.NODE_ENV;
    }
  });
});
