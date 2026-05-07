// Cross-repo invariant tests for `projectHash()`.
//
// The customer plugin hooks (mysecond-ai/product-manager-os companion-sync)
// compute the same value inline AFTER calling realpath(PROJECT_DIR):
//   ABS_PROJ=$(python3 -c 'os.path.realpath(...)')
//   sha256(ABS_PROJ).hex[:8]
//
// Track T3 (Closure D2) added the realpath step on the CLI side too so
// macOS tmpdir symlink shenanigans (`/var/folders/...` →
// `/private/var/folders/...`) don't desync the two implementations and
// silently disable team-mode binding (closure A).
//
// If the algorithm here ever drifts, every customer's project-scoped credential
// path silently moves to a new directory and they fall back to global creds —
// exactly the silent-401 outage class we already fixed once. These tests
// hardcode expected hashes for known inputs so drift screams.

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { projectHash } from '../../src/lib/project-hash.js';

describe('projectHash — cross-repo invariant', () => {
  // Hash values computed once by `node -e "console.log(require('crypto').createHash('sha256').update(STR).digest('hex').slice(0,8))"`.
  // If you're updating these because the algorithm changed, you MUST also
  // update the hook's inline computation in mysecond-ai/product-manager-os/
  // companion-sync/hooks/{post-tool-use-sync.sh,session-start-sync.sh}.

  const VECTORS: ReadonlyArray<{ input: string; expected: string }> = [
    { input: '/Users/test/proj', expected: 'e8faf588' },
    { input: '/Users/ronyang/Desktop/0501i', expected: '184bd18c' },
    { input: '/tmp/cli-smoke', expected: 'bd4979ab' },
    { input: '', expected: 'e3b0c442' }, // sha256 of empty string, sliced
  ];

  for (const { input, expected } of VECTORS) {
    it(`hashes ${JSON.stringify(input)} → ${expected}`, () => {
      expect(projectHash(input)).toBe(expected);
    });
  }

  it('returns exactly 8 hex characters', () => {
    expect(projectHash('/any/path')).toMatch(/^[a-f0-9]{8}$/);
  });

  it('is deterministic across calls', () => {
    const path = '/Users/abc/def';
    expect(projectHash(path)).toBe(projectHash(path));
  });

  it('is sensitive to single-character changes', () => {
    expect(projectHash('/Users/test/proj')).not.toBe(projectHash('/Users/test/Proj'));
    expect(projectHash('/Users/test/proj')).not.toBe(projectHash('/Users/test/proj/'));
  });
});

// Track T3 (Closure D2) regression test: symlinked paths must hash the same
// as their realpath target. Pre-T3 the CLI hashed the literal path while the
// hook hashed the realpath — on macOS this silently disabled team-mode for
// every customer whose --project-dir traversed `/var/folders/...` (the
// default mktemp root, symlinked to `/private/var/folders/...`).
describe('projectHash — symlink resolution (Track T3 regression)', () => {
  let scratchRoot: string;
  let realDir: string;
  let symlinkDir: string;

  beforeEach(() => {
    scratchRoot = mkdtempSync(join(tmpdir(), 'cli-projhash-'));
    realDir = join(scratchRoot, 'real');
    symlinkDir = join(scratchRoot, 'link');
    mkdirSync(realDir, { recursive: true });
    symlinkSync(realDir, symlinkDir, 'dir');
  });

  afterEach(() => {
    try {
      rmSync(scratchRoot, { recursive: true, force: true });
    } catch {}
  });

  it('symlinked path and its real target produce the same hash', () => {
    // The whole point of the realpath fix: same project, two paths, one
    // hash. Without realpath, these would differ and team-mode binding
    // would silently break for any customer on a path that traverses a
    // symlink (the macOS tmpdir scenario, plus user-customized symlinked
    // home dirs in some IT-managed environments).
    expect(projectHash(symlinkDir)).toBe(projectHash(realDir));
  });

  it('non-existent paths fall back to verbatim hashing (no throw)', () => {
    // Mirrors the hook's `|| echo "$PROJECT_DIR"` fallback. Important for
    // dry-run / pre-init scenarios where --project-dir may point at a
    // not-yet-created tree.
    const ghostPath = join(scratchRoot, 'does-not-exist');
    expect(() => projectHash(ghostPath)).not.toThrow();
    expect(projectHash(ghostPath)).toMatch(/^[a-f0-9]{8}$/);
  });
});
