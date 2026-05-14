// Tests for prune-stale-plugins.ts — the core Finding #2 ("duplicate skills") fix.
//
// Strategy:
//   - planStalePluginPrune: pure function over installed_plugins.json — drive
//     it with a tmp HOME containing a hand-built ledger. No child_process.
//   - pruneStalePlugins: inject a FAKE `claude` binary (a tiny shell script)
//     via the `claudeBin` option. The fake records every invocation to a log
//     file so we can assert exactly which plugins were uninstalled, and can be
//     made to exit non-zero to exercise the failure path.

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  planStalePluginPrune,
  pruneStalePlugins,
  installedPluginsJsonPath,
} from '../../src/lib/prune-stale-plugins.js';

let root: string;
let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mysecond-prune-'));
  home = join(root, 'home');
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
  originalHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(root, { recursive: true, force: true });
});

// Write a ledger to ~/.claude/plugins/installed_plugins.json from a list of keys.
function writeLedger(keys: string[]): void {
  const plugins: Record<string, unknown> = {};
  for (const k of keys) plugins[k] = [{ scope: 'user', version: '1.0.0' }];
  writeFileSync(installedPluginsJsonPath(), JSON.stringify({ version: 2, plugins }, null, 2));
}

// Create a fake `claude` binary that logs argv to <root>/claude-calls.log and
// exits with `exitCode`. Returns its absolute path for the `claudeBin` option.
function makeFakeClaude(exitCode = 0): string {
  const logPath = join(root, 'claude-calls.log');
  const binPath = join(root, 'fake-claude.sh');
  writeFileSync(
    binPath,
    `#!/bin/sh\necho "$@" >> "${logPath}"\nexit ${exitCode}\n`,
  );
  chmodSync(binPath, 0o755);
  return binPath;
}

function readClaudeCalls(): string[] {
  const logPath = join(root, 'claude-calls.log');
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
}

// The 13-plugin-era plugin names (from installed_plugins.json inspection).
const EXPERIMENT_PLUGINS = [
  'pm-communication',
  'pm-competitive',
  'pm-data',
  'pm-discovery',
  'pm-launch',
  'pm-operations',
  'pm-planning',
  'pm-specs',
  'pm-strategy',
  'pm-companion-sync',
  'pm-personas',
  'pm-workflows',
  'pm-cc',
];

describe('planStalePluginPrune', () => {
  it('returns empty plan when the ledger is missing', () => {
    const plan = planStalePluginPrune('t0504b-to57');
    expect(plan.stalePluginNames).toEqual([]);
    expect(plan.marketplace).toBe('mysecond-customer-t0504b-to57');
  });

  it('returns empty plan when the ledger is corrupt JSON', () => {
    writeFileSync(installedPluginsJsonPath(), '{ not valid json');
    expect(planStalePluginPrune('t0504b-to57').stalePluginNames).toEqual([]);
  });

  it('finds all 13 stale pm-* plugins for the customer slug, excludes pm-os', () => {
    const slug = 't0504b-to57';
    const mkt = `mysecond-customer-${slug}`;
    writeLedger([
      ...EXPERIMENT_PLUGINS.map((p) => `${p}@${mkt}`),
      `pm-os@${mkt}`, // the current, correct plugin — must NOT be flagged
    ]);
    const plan = planStalePluginPrune(slug);
    expect(plan.stalePluginNames).toEqual([...EXPERIMENT_PLUGINS].sort());
    expect(plan.stalePluginNames).not.toContain('pm-os');
  });

  it('returns empty plan for a clean flat-only install (only pm-os)', () => {
    const slug = 't0511a-qomg';
    writeLedger([`pm-os@mysecond-customer-${slug}`]);
    expect(planStalePluginPrune(slug).stalePluginNames).toEqual([]);
  });

  it('NEVER touches another customer\'s entries (slug scoping)', () => {
    // Two customers on one machine (only happens on test machines). Pruning
    // for customer A must leave customer B's stale plugins completely alone.
    writeLedger([
      'pm-data@mysecond-customer-aaaa-1111',
      'pm-strategy@mysecond-customer-aaaa-1111',
      'pm-os@mysecond-customer-aaaa-1111',
      'pm-data@mysecond-customer-bbbb-2222',
      'pm-os@mysecond-customer-bbbb-2222',
    ]);
    const plan = planStalePluginPrune('aaaa-1111');
    expect(plan.stalePluginNames).toEqual(['pm-data', 'pm-strategy']);
  });

  it('does not match a slug that is a prefix of another slug', () => {
    // Suffix match must be exact: slug `t05` must not match `t0501`.
    writeLedger([
      'pm-data@mysecond-customer-t0501',
      'pm-os@mysecond-customer-t0501',
    ]);
    expect(planStalePluginPrune('t05').stalePluginNames).toEqual([]);
  });

  it('ignores non-mysecond marketplaces entirely', () => {
    writeLedger([
      'playwright@claude-plugins-official',
      'vercel@claude-plugins-official',
      'pm-data@mysecond-customer-t0504b-to57',
      'pm-os@mysecond-customer-t0504b-to57',
    ]);
    expect(planStalePluginPrune('t0504b-to57').stalePluginNames).toEqual(['pm-data']);
  });
});

describe('pruneStalePlugins', () => {
  it('is a no-op when there are no stale plugins', () => {
    writeLedger(['pm-os@mysecond-customer-t0511a-qomg']);
    const fakeClaude = makeFakeClaude(0);
    const result = pruneStalePlugins('t0511a-qomg', { claudeBin: fakeClaude, silent: true });
    expect(result.noop).toBe(true);
    expect(result.removed).toEqual([]);
    expect(readClaudeCalls()).toEqual([]); // never shelled out
  });

  it('uninstalls every stale plugin via `claude plugin uninstall`', () => {
    const slug = 't0504b-to57';
    const mkt = `mysecond-customer-${slug}`;
    writeLedger([
      ...EXPERIMENT_PLUGINS.map((p) => `${p}@${mkt}`),
      `pm-os@${mkt}`,
    ]);
    const fakeClaude = makeFakeClaude(0);
    const result = pruneStalePlugins(slug, { claudeBin: fakeClaude, silent: true });

    expect(result.noop).toBe(false);
    expect(result.removed.sort()).toEqual([...EXPERIMENT_PLUGINS].sort());
    expect(result.failed).toEqual([]);

    const calls = readClaudeCalls();
    expect(calls).toHaveLength(EXPERIMENT_PLUGINS.length);
    for (const p of EXPERIMENT_PLUGINS) {
      expect(calls).toContain(`plugin uninstall ${p}@${mkt} --scope user`);
    }
    // pm-os must never be uninstalled.
    expect(calls.some((c) => c.includes('pm-os@'))).toBe(false);
  });

  it('records plugins as failed when `claude plugin uninstall` exits non-zero', () => {
    const slug = 't0504b-to57';
    const mkt = `mysecond-customer-${slug}`;
    writeLedger([`pm-data@${mkt}`, `pm-strategy@${mkt}`, `pm-os@${mkt}`]);
    const fakeClaude = makeFakeClaude(1); // every uninstall fails
    const result = pruneStalePlugins(slug, { claudeBin: fakeClaude, silent: true });

    expect(result.noop).toBe(false);
    expect(result.removed).toEqual([]);
    expect(result.failed.sort()).toEqual(['pm-data', 'pm-strategy']);
  });

  it('cleans up the cache dir for a pruned plugin', () => {
    const slug = 't0504b-to57';
    const mkt = `mysecond-customer-${slug}`;
    writeLedger([`pm-data@${mkt}`, `pm-os@${mkt}`]);
    // Pre-create the stale plugin's cache dir.
    const cacheDir = join(home, '.claude', 'plugins', 'cache', mkt, 'pm-data');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'marker'), 'stale');

    const fakeClaude = makeFakeClaude(0);
    pruneStalePlugins(slug, { claudeBin: fakeClaude, silent: true });

    expect(existsSync(cacheDir)).toBe(false);
  });

  it('does not throw when the fake binary is missing (ENOENT)', () => {
    const slug = 't0504b-to57';
    writeLedger([`pm-data@mysecond-customer-${slug}`, `pm-os@mysecond-customer-${slug}`]);
    // Point at a nonexistent binary — spawnSync returns status null + error.
    const result = pruneStalePlugins(slug, {
      claudeBin: join(root, 'does-not-exist'),
      silent: true,
    });
    expect(result.failed).toEqual(['pm-data']);
    expect(result.removed).toEqual([]);
  });
});
