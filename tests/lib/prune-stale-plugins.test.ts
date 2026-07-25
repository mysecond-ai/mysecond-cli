// Tests for prune-stale-plugins.ts — the core Finding #2 ("duplicate skills")
// fix, hardened per the Codex adversarial review (cli#32).
//
// Strategy:
//   - planStalePluginPrune: pure function over installed_plugins.json — drive
//     it with a tmp HOME containing a hand-built ledger. No child_process.
//   - pruneStalePlugins: inject a FAKE `claude` binary (a tiny shell script)
//     via the `claudeBin` option. The fake records every invocation to a log
//     file so we can assert exactly which plugins were uninstalled, and can be
//     made to exit non-zero / hang to exercise the failure + timeout paths.
//
// Hardening coverage:
//   P0-1 path traversal — a malformed ledger key with `..`/`/`/`@` in the
//        plugin-name segment must NOT be uninstalled or rmSync'd.
//   P0-2 slug validation — an invalid slug must no-op cleanly (no throw, no
//        path construction).
//   P0-3 allowlist — only the 13 KNOWN experiment plugins are pruned; a
//        legitimate non-pm-os plugin under the marketplace is left alone.
//   P1-4 cache cleanup only after a successful uninstall.
//   P1-5 concurrency — a second concurrent prune backs off cleanly when the
//        `~/.claude/plugins/` lock is held; the plan re-read inside the lock
//        treats an already-pruned ledger as a clean no-op.
//   P2-6 spawnSync timeout — a hung uninstall is a non-fatal failure.

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

import lockfile from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installFakeHome, type FakeHome } from '../helpers/fake-home.js';
import {
  planStalePluginPrune,
  pruneStalePlugins,
  installedPluginsJsonPath,
  EXPERIMENT_PLUGINS,
} from '../../src/lib/prune-stale-plugins.js';

let root: string;
let home: string;
let fakeHome: FakeHome;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mysecond-prune-'));
  home = join(root, 'home');
  // Sets BOTH HOME and USERPROFILE — os.homedir() reads USERPROFILE on win32,
  // so a HOME-only override sandboxes nothing there.
  fakeHome = installFakeHome(undefined, home);
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
});

afterEach(() => {
  fakeHome.restore();
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
// Cross-platform (win32 PR 4): on Windows this writes a .cmd batch file —
// which also exercises spawnClaude's shell:true path for real, since a bare
// spawnSync of a .cmd throws EINVAL on Node >=20.12.
const IS_WIN = process.platform === 'win32';

function makeFakeClaude(exitCode = 0): string {
  const logPath = join(root, 'claude-calls.log');
  if (IS_WIN) {
    const binPath = join(root, 'fake-claude.cmd');
    writeFileSync(
      binPath,
      `@echo off\r\necho %*>> "${logPath}"\r\nexit /b ${exitCode}\r\n`,
    );
    return binPath;
  }
  const binPath = join(root, 'fake-claude.sh');
  writeFileSync(
    binPath,
    `#!/bin/sh\necho "$@" >> "${logPath}"\nexit ${exitCode}\n`,
  );
  chmodSync(binPath, 0o755);
  return binPath;
}

// Create a fake `claude` that logs its call then sleeps far longer than the
// 30s spawnSync timeout — used to exercise the P2-6 timeout path.
// win32 delay: `ping -n N+1 127.0.0.1` waits ~N seconds (the batch-file
// idiom; `timeout.exe` refuses to run without a console on CI).
function makeHangingClaude(sleepSeconds: number): string {
  const logPath = join(root, 'claude-calls.log');
  if (IS_WIN) {
    const binPath = join(root, 'hanging-claude.cmd');
    writeFileSync(
      binPath,
      `@echo off\r\necho %*>> "${logPath}"\r\nping -n ${sleepSeconds + 1} 127.0.0.1 >nul\r\n`,
    );
    return binPath;
  }
  const binPath = join(root, 'hanging-claude.sh');
  writeFileSync(
    binPath,
    `#!/bin/sh\necho "$@" >> "${logPath}"\nsleep ${sleepSeconds}\n`,
  );
  chmodSync(binPath, 0o755);
  return binPath;
}

// Create a fake `claude` that logs its call AND rewrites the ledger to remove
// EVERY stale `pm-*@mysecond-customer-*` entry — simulating a concurrent
// process having finished the prune. Used to prove the plan re-read inside the
// lock treats an already-pruned ledger as a clean no-op on a subsequent call.
function makeLedgerClearingClaude(): string {
  const logPath = join(root, 'claude-calls.log');
  const ledgerPath = installedPluginsJsonPath();
  const cleanLedger = '{ "version": 2, "plugins": { "pm-os@mysecond-customer-t0504b-to57": [ { "scope": "user", "version": "1.0.0" } ] } }';
  if (IS_WIN) {
    const binPath = join(root, 'ledger-clearing-claude.cmd');
    // Batch: log argv, then overwrite the ledger via a helper node one-liner
    // (batch echo would mangle the JSON quoting).
    const jsonB64 = Buffer.from(cleanLedger).toString('base64');
    writeFileSync(
      binPath,
      `@echo off\r\necho %*>> "${logPath}"\r\nnode -e "require('fs').writeFileSync(process.argv[1], Buffer.from(process.argv[2], 'base64').toString())" "${ledgerPath}" ${jsonB64}\r\nexit /b 0\r\n`,
    );
    return binPath;
  }
  const binPath = join(root, 'ledger-clearing-claude.sh');
  // POSIX sh: log argv, then overwrite the ledger with a pm-os-only ledger.
  writeFileSync(
    binPath,
    `#!/bin/sh
echo "$@" >> "${logPath}"
cat > "${ledgerPath}" <<'JSON'
${cleanLedger}
JSON
exit 0
`,
  );
  chmodSync(binPath, 0o755);
  return binPath;
}

function readClaudeCalls(): string[] {
  const logPath = join(root, 'claude-calls.log');
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
}

describe('EXPERIMENT_PLUGINS allowlist', () => {
  it('contains exactly the 13 known experiment plugin names', () => {
    expect([...EXPERIMENT_PLUGINS].sort()).toEqual(
      [
        'pm-cc',
        'pm-communication',
        'pm-companion-sync',
        'pm-competitive',
        'pm-data',
        'pm-discovery',
        'pm-launch',
        'pm-operations',
        'pm-personas',
        'pm-planning',
        'pm-specs',
        'pm-strategy',
        'pm-workflows',
      ].sort(),
    );
  });

  it('is frozen — callers cannot mutate the allowlist at runtime', () => {
    expect(Object.isFrozen(EXPERIMENT_PLUGINS)).toBe(true);
  });
});

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

  it("NEVER touches another customer's entries (slug scoping)", () => {
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

  // ---- P0-3: allowlist ----
  it('does NOT prune a non-pm-os plugin that is NOT on the allowlist', () => {
    // A hypothetical future / beta / support plugin under the customer
    // marketplace. "not pm-os" is not sufficient — only the 13 known
    // experiment plugins are pruned.
    const mkt = 'mysecond-customer-t0504b-to57';
    writeLedger([
      `pm-os@${mkt}`,
      `pm-future-beta@${mkt}`, // legit, not on allowlist → keep
      `pm-support-tools@${mkt}`, // legit, not on allowlist → keep
      `pm-data@${mkt}`, // on allowlist → prune
    ]);
    expect(planStalePluginPrune('t0504b-to57').stalePluginNames).toEqual(['pm-data']);
  });

  // ---- P0-1: path traversal ----
  it('rejects a malformed ledger key whose plugin-name segment has path traversal', () => {
    // A crafted key whose "<plugin>" segment is `../../cache/.../vercel`.
    // It DOES end with the customer marketplace suffix, so a naive endsWith()
    // check passes — but the plugin-name token guard + allowlist must drop it
    // so it never reaches `claude plugin uninstall` or rmSync.
    const mkt = 'mysecond-customer-t0504b-to57';
    writeLedger([
      `pm-os@${mkt}`,
      `../../cache/claude-plugins-official/vercel@${mkt}`,
      `pm-data/../../etc@${mkt}`,
      `pm-data@${mkt}`, // the one legitimate stale entry
    ]);
    // Only the clean allowlisted token survives.
    expect(planStalePluginPrune('t0504b-to57').stalePluginNames).toEqual(['pm-data']);
  });

  // ---- P0-2: slug validation ----
  it('returns empty plan for an invalid slug (no throw, no path construction)', () => {
    writeLedger([
      'pm-data@mysecond-customer-../../etc',
      'pm-os@mysecond-customer-../../etc',
    ]);
    // A path-traversal slug must be rejected by validateSlug → empty plan,
    // empty marketplace, no throw.
    const plan = planStalePluginPrune('../../etc');
    expect(plan.stalePluginNames).toEqual([]);
    expect(plan.marketplace).toBe('');
  });

  it('returns empty plan for an empty-string slug', () => {
    expect(planStalePluginPrune('').stalePluginNames).toEqual([]);
  });
});

describe('pruneStalePlugins', () => {
  it('is a no-op when there are no stale plugins', async () => {
    writeLedger(['pm-os@mysecond-customer-t0511a-qomg']);
    const fakeClaude = makeFakeClaude(0);
    const result = await pruneStalePlugins('t0511a-qomg', {
      claudeBin: fakeClaude,
      silent: true,
    });
    expect(result.noop).toBe(true);
    expect(result.removed).toEqual([]);
    expect(readClaudeCalls()).toEqual([]); // never shelled out
  });

  it('is a no-op for an invalid slug (P0-2 — sync path passes unvalidated slugs)', async () => {
    writeLedger(['pm-data@mysecond-customer-../../etc']);
    const fakeClaude = makeFakeClaude(0);
    const result = await pruneStalePlugins('../../etc', {
      claudeBin: fakeClaude,
      silent: true,
    });
    expect(result.noop).toBe(true);
    expect(readClaudeCalls()).toEqual([]);
  });

  it('uninstalls every stale plugin via `claude plugin uninstall`', async () => {
    const slug = 't0504b-to57';
    const mkt = `mysecond-customer-${slug}`;
    writeLedger([
      ...EXPERIMENT_PLUGINS.map((p) => `${p}@${mkt}`),
      `pm-os@${mkt}`,
    ]);
    const fakeClaude = makeFakeClaude(0);
    const result = await pruneStalePlugins(slug, { claudeBin: fakeClaude, silent: true });

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

  it('does NOT uninstall a non-allowlist plugin under the marketplace (P0-3)', async () => {
    const slug = 't0504b-to57';
    const mkt = `mysecond-customer-${slug}`;
    writeLedger([
      `pm-os@${mkt}`,
      `pm-future-beta@${mkt}`, // legit non-pm-os, not on allowlist
      `pm-data@${mkt}`, // on allowlist
    ]);
    const fakeClaude = makeFakeClaude(0);
    const result = await pruneStalePlugins(slug, { claudeBin: fakeClaude, silent: true });

    expect(result.removed).toEqual(['pm-data']);
    const calls = readClaudeCalls();
    expect(calls).toEqual([`plugin uninstall pm-data@${mkt} --scope user`]);
    expect(calls.some((c) => c.includes('pm-future-beta'))).toBe(false);
  });

  it('records plugins as failed when `claude plugin uninstall` exits non-zero', async () => {
    const slug = 't0504b-to57';
    const mkt = `mysecond-customer-${slug}`;
    writeLedger([`pm-data@${mkt}`, `pm-strategy@${mkt}`, `pm-os@${mkt}`]);
    const fakeClaude = makeFakeClaude(1); // every uninstall fails
    const result = await pruneStalePlugins(slug, { claudeBin: fakeClaude, silent: true });

    expect(result.noop).toBe(false);
    expect(result.removed).toEqual([]);
    expect(result.failed.sort()).toEqual(['pm-data', 'pm-strategy']);
  });

  it('cleans up the cache dir ONLY after a successful uninstall (P1-4)', async () => {
    const slug = 't0504b-to57';
    const mkt = `mysecond-customer-${slug}`;
    writeLedger([`pm-data@${mkt}`, `pm-os@${mkt}`]);
    // Pre-create the stale plugin's cache dir.
    const cacheDir = join(home, '.claude', 'plugins', 'cache', mkt, 'pm-data');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'marker'), 'stale');

    const fakeClaude = makeFakeClaude(0);
    await pruneStalePlugins(slug, { claudeBin: fakeClaude, silent: true });

    expect(existsSync(cacheDir)).toBe(false);
  });

  it('does NOT delete the cache dir when uninstall FAILS (P1-4)', async () => {
    const slug = 't0504b-to57';
    const mkt = `mysecond-customer-${slug}`;
    writeLedger([`pm-data@${mkt}`, `pm-os@${mkt}`]);
    const cacheDir = join(home, '.claude', 'plugins', 'cache', mkt, 'pm-data');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'marker'), 'stale');

    const fakeClaude = makeFakeClaude(1); // uninstall fails
    const result = await pruneStalePlugins(slug, { claudeBin: fakeClaude, silent: true });

    expect(result.failed).toEqual(['pm-data']);
    // Cache dir MUST survive — deleting it behind a still-registered ledger
    // entry would break Claude startup.
    expect(existsSync(cacheDir)).toBe(true);
  });

  it('does not throw when the fake binary is missing (ENOENT)', async () => {
    const slug = 't0504b-to57';
    writeLedger([`pm-data@mysecond-customer-${slug}`, `pm-os@mysecond-customer-${slug}`]);
    // Point at a nonexistent binary — spawnSync returns status null + error.
    const result = await pruneStalePlugins(slug, {
      claudeBin: join(root, 'does-not-exist'),
      silent: true,
    });
    expect(result.failed).toEqual(['pm-data']);
    expect(result.removed).toEqual([]);
  });

  it('treats a hung uninstall as a non-fatal failure (P2-6 — timeout)', async () => {
    // The fake `claude` sleeps 35s — longer than the 30s spawnSync timeout in
    // pruneStalePlugins. spawnSync kills it with SIGTERM; the plugin is
    // recorded as `failed`, not `removed`, and the function returns cleanly.
    const slug = 't0504b-to57';
    const mkt = `mysecond-customer-${slug}`;
    writeLedger([`pm-data@${mkt}`, `pm-os@${mkt}`]);
    const cacheDir = join(home, '.claude', 'plugins', 'cache', mkt, 'pm-data');
    mkdirSync(cacheDir, { recursive: true });

    const hangingClaude = makeHangingClaude(35);
    const result = await pruneStalePlugins(slug, {
      claudeBin: hangingClaude,
      silent: true,
    });

    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual(['pm-data']);
    // A timed-out uninstall is a failure → cache dir must NOT be deleted.
    expect(existsSync(cacheDir)).toBe(true);
  }, 40_000); // bump per-test timeout past the 30s spawnSync timeout
});

describe('pruneStalePlugins — concurrency (P1-5)', () => {
  // The lock anchor: pruneStalePlugins serializes on `~/.claude/plugins/`.
  function claudePluginsDir(): string {
    return join(home, '.claude', 'plugins');
  }

  it('backs off cleanly (no shell-out) when the plugin-dir lock is already held', async () => {
    const slug = 't0504b-to57';
    const mkt = `mysecond-customer-${slug}`;
    writeLedger([`pm-data@${mkt}`, `pm-strategy@${mkt}`, `pm-os@${mkt}`]);
    const fakeClaude = makeFakeClaude(0);

    // Simulate a concurrent `mysecond sync` (every SessionStart) by holding the
    // `~/.claude/plugins/` lock ourselves. proper-lockfile's retry budget is
    // 5×100ms — far short of LOCK_STALE_MS — so the second prune can't acquire
    // it and must back off to a clean no-op rather than stealing the lock.
    const release = await lockfile.lock(claudePluginsDir(), {
      retries: { retries: 0 },
      stale: 600_000,
    });
    try {
      const result = await pruneStalePlugins(slug, { claudeBin: fakeClaude, silent: true });
      expect(result.noop).toBe(true);
      expect(result.removed).toEqual([]);
      expect(result.failed).toEqual([]);
      // CRITICAL: never shelled out to `claude` while another process held
      // the lock — no racing uninstalls.
      expect(readClaudeCalls()).toEqual([]);
    } finally {
      await release();
    }

    // Sanity: once the lock is free, the same prune runs normally.
    const after = await pruneStalePlugins(slug, { claudeBin: fakeClaude, silent: true });
    expect(after.noop).toBe(false);
    expect(after.removed.sort()).toEqual(['pm-data', 'pm-strategy']);
  });

  it('the plan re-read inside the lock treats an already-pruned ledger as a clean no-op', async () => {
    const slug = 't0504b-to57';
    const mkt = `mysecond-customer-${slug}`;
    writeLedger([`pm-data@${mkt}`, `pm-strategy@${mkt}`, `pm-os@${mkt}`]);

    // First prune uses a fake `claude` that ALSO rewrites the ledger to a
    // pm-os-only state — i.e. by the time it finishes, the ledger looks like a
    // concurrent process already cleaned everything.
    const clearingClaude = makeLedgerClearingClaude();
    const first = await pruneStalePlugins(slug, { claudeBin: clearingClaude, silent: true });
    expect(first.noop).toBe(false);
    expect(first.removed.length).toBeGreaterThan(0);

    // Second prune: the ledger now has only pm-os. The plan re-read (both at
    // function entry AND inside the lock) finds nothing stale → clean no-op,
    // no shell-out for this second call.
    const callsAfterFirst = readClaudeCalls().length;
    const second = await pruneStalePlugins(slug, { claudeBin: clearingClaude, silent: true });
    expect(second.noop).toBe(true);
    expect(second.removed).toEqual([]);
    expect(second.failed).toEqual([]);
    // No additional `claude` invocations from the second (no-op) call.
    expect(readClaudeCalls().length).toBe(callsAfterFirst);
  });
});
