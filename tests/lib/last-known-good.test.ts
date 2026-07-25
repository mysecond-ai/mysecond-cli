// Tests for last-known-good cache behavior. We sandbox the home dir to a
// tmpdir so tests don't pollute the real ~/.mysecond. installFakeHome sets
// BOTH HOME and USERPROFILE — os.homedir() reads USERPROFILE on win32, so a
// HOME-only override sandboxes nothing there.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installFakeHome, type FakeHome } from '../helpers/fake-home.js';

let fake: FakeHome;
let fakeHome: string;

beforeEach(() => {
  fake = installFakeHome('mysecond-lkg-');
  fakeHome = fake.home;
  // Force a fresh import of mysecond-paths + last-known-good so they pick up the
  // overridden home. Vitest caches module evaluations, so we reset between tests.
  vi.resetModules();
});

afterEach(() => {
  fake.restore();
  // fake.home lives inside a mkdtemp parent — remove the whole temp tree.
  rmSync(dirname(fakeHome), { recursive: true, force: true });
});

async function loadModule(): Promise<typeof import('../../src/lib/last-known-good.js')> {
  return await import('../../src/lib/last-known-good.js');
}

describe('last-known-good cache (Decision 0-C guardrail #3)', () => {
  it('returns null on first call when no cache exists', async () => {
    const mod = await loadModule();
    expect(mod.findLastKnownGood('acme')).toBeNull();
  });

  it('caches a validated plugin tree and finds it back', async () => {
    const mod = await loadModule();
    // Simulate a successfully-extracted plugin tree.
    const sourceDir = join(fakeHome, 'src-plugin');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'manifest.json'), '{"name":"pm-os"}');

    mod.cacheLastKnownGood('acme', '1.0.0', 'sha256-fake', sourceDir);
    const hit = mod.findLastKnownGood('acme');
    expect(hit).not.toBeNull();
    expect(hit!.version).toBe('1.0.0');
    expect(hit!.cached_age_hours).toBeGreaterThanOrEqual(0);

    // Ensure the cached tree contains our manifest.
    const cachedManifest = readFileSync(join(hit!.source_dir, 'manifest.json'), 'utf8');
    expect(cachedManifest).toContain('pm-os');
  });

  it('evicts oldest version when over MAX_CACHED_VERSIONS (3)', async () => {
    const mod = await loadModule();
    const src = join(fakeHome, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'x'), '');

    mod.cacheLastKnownGood('acme', '1.0.0', 'sha-1', src);
    await new Promise((r) => setTimeout(r, 10));
    mod.cacheLastKnownGood('acme', '1.1.0', 'sha-2', src);
    await new Promise((r) => setTimeout(r, 10));
    mod.cacheLastKnownGood('acme', '1.2.0', 'sha-3', src);
    await new Promise((r) => setTimeout(r, 10));
    mod.cacheLastKnownGood('acme', '1.3.0', 'sha-4', src);

    // Newest should be findable; oldest (1.0.0) evicted.
    const hit = mod.findLastKnownGood('acme');
    expect(hit!.version).toBe('1.3.0');
  });

  it('purgeLastKnownGood (CRO mitigation) removes all cached versions for a customer', async () => {
    const mod = await loadModule();
    const src = join(fakeHome, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'x'), '');

    mod.cacheLastKnownGood('acme', '1.0.0', 'sha-1', src);
    expect(mod.findLastKnownGood('acme')).not.toBeNull();

    mod.purgeLastKnownGood('acme');
    expect(mod.findLastKnownGood('acme')).toBeNull();
  });
});
