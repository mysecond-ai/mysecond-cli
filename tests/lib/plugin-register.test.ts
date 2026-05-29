// Tests for registerMarketplaceAndInstall — the shared Claude Code registration
// mechanics used by plugin-refresh. Mocks spawnSync so we can drive each outcome
// (ENOENT / timeout / non-zero exit / success) deterministically.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync: h.spawnSync }));

import { registerMarketplaceAndInstall } from '../../src/lib/plugin-register.js';
import { SENTINEL_PLUGIN_NAME, type PluginEntry } from '../../src/lib/mysecond-paths.js';

type SpawnReturn = ReturnType<typeof import('node:child_process').spawnSync>;
function ok(): Partial<SpawnReturn> {
  return { status: 0, signal: null };
}
function nonZero(status = 1): Partial<SpawnReturn> {
  return { status, signal: null };
}
function enoent(): Partial<SpawnReturn> {
  return { status: null, signal: null, error: Object.assign(new Error('spawn enoent'), { code: 'ENOENT' }) };
}
function timedOut(): Partial<SpawnReturn> {
  return { status: null, signal: 'SIGTERM' };
}

const sentinel = [{ name: SENTINEL_PLUGIN_NAME }] as unknown as PluginEntry[];
function params(overrides: Partial<Parameters<typeof registerMarketplaceAndInstall>[0]> = {}) {
  return {
    slug: 'acme',
    plugins: sentinel,
    claudeBin: '/bin/claude',
    deadlineMs: Date.now() + 30_000,
    silent: true,
    ...overrides,
  };
}

beforeEach(() => h.spawnSync.mockReset());
afterEach(() => vi.clearAllMocks());

describe('registerMarketplaceAndInstall', () => {
  it('runs marketplace remove → add → install in order and returns registered', () => {
    h.spawnSync.mockReturnValue(ok());
    const r = registerMarketplaceAndInstall(params());
    expect(r.outcome.kind).toBe('registered');
    const cmds = h.spawnSync.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(cmds[0]).toContain('marketplace remove');
    expect(cmds[1]).toContain('marketplace add');
    expect(cmds[2]).toContain('install');
    // remove must come before add (idempotency contract).
    expect(cmds[0].indexOf('remove')).toBeGreaterThanOrEqual(0);
    expect(cmds[1].indexOf('add')).toBeGreaterThanOrEqual(0);
  });

  it('returns binary_not_found on ENOENT from marketplace add', () => {
    h.spawnSync.mockReturnValueOnce(ok()).mockReturnValueOnce(enoent());
    expect(registerMarketplaceAndInstall(params()).outcome.kind).toBe('binary_not_found');
  });

  it('returns timed_out when a spawn is killed by the budget (SIGTERM)', () => {
    h.spawnSync.mockReturnValueOnce(ok()).mockReturnValueOnce(timedOut());
    expect(registerMarketplaceAndInstall(params()).outcome.kind).toBe('timed_out');
  });

  it('returns failed when marketplace add exits non-zero', () => {
    h.spawnSync.mockReturnValueOnce(ok()).mockReturnValueOnce(nonZero(1));
    const r = registerMarketplaceAndInstall(params());
    expect(r.outcome.kind).toBe('failed');
  });

  it('returns failed when the SENTINEL plugin install exits non-zero', () => {
    h.spawnSync.mockReturnValueOnce(ok()).mockReturnValueOnce(ok()).mockReturnValueOnce(nonZero(1));
    const r = registerMarketplaceAndInstall(params());
    expect(r.outcome.kind).toBe('failed');
    expect(r.failedPlugins).toContain(SENTINEL_PLUGIN_NAME);
  });

  it('tolerates a non-sentinel install failure (records it, still registered)', () => {
    const plugins = [{ name: 'pm-extra' }, { name: SENTINEL_PLUGIN_NAME }] as unknown as PluginEntry[];
    // remove ok, add ok, install pm-extra fails, install pm-os ok.
    h.spawnSync
      .mockReturnValueOnce(ok())
      .mockReturnValueOnce(ok())
      .mockReturnValueOnce(nonZero(1))
      .mockReturnValueOnce(ok());
    const r = registerMarketplaceAndInstall(params({ plugins }));
    expect(r.outcome.kind).toBe('registered');
    expect(r.failedPlugins).toEqual(['pm-extra']);
  });

  it('returns timed_out without spawning when the deadline already passed', () => {
    h.spawnSync.mockReturnValue(ok());
    const r = registerMarketplaceAndInstall(params({ deadlineMs: Date.now() - 1 }));
    expect(r.outcome.kind).toBe('timed_out');
    expect(h.spawnSync).not.toHaveBeenCalled();
  });
});
