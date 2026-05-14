// prune-stale-plugins.ts — make the plugin install REPLACING, not additive.
//
// THE BUG (Finding #2 / "duplicate skills"):
// During a multi-category experiment window (2026-05-04 → 2026-05-05), the cli
// installed each customer as 13 separately-named plugins (`pm-communication`,
// `pm-competitive`, `pm-data`, …, `pm-cc`) under the customer's marketplace
// `mysecond-customer-<slug>`. Before and after that window, the cli installs a
// single flat `pm-os` plugin under the same marketplace name.
//
// The cli install path (`claude plugin install pm-os@<marketplace>`) is purely
// ADDITIVE — it never uninstalls a customer's prior plugins. So a customer who
// onboarded during the experiment window and later re-synced ends up with BOTH
// the 13 old `pm-*` plugins AND the new `pm-os`, all registered in
// `~/.claude/plugins/installed_plugins.json`. Claude Code namespaces a skill by
// its plugin's name, so every skill appears twice: the correct un-prefixed one
// from `pm-os`, plus an abandoned `pm-data:funnel-analyzer`-style duplicate.
//
// THE FIX:
// After installing the current `pm-os` plugin, enumerate every plugin entry
// keyed `<plugin>@mysecond-customer-<slug>` for THIS customer's slug, and
// `claude plugin uninstall` any whose plugin name is not `pm-os`. The
// per-customer marketplace registration itself is preserved — `pm-os` still
// needs it. Only the orphaned individual plugin entries are removed.
//
// SAFETY — scope strictly to the customer's OWN slug:
// A real customer machine has exactly one customer (one slug). Only internal
// test machines accumulate many. The marketplace-suffix match
// (`@mysecond-customer-<slug>`) guarantees we never touch another customer's
// entries, another marketplace's plugins (playwright@claude-plugins-official),
// or the current `pm-os` install.
//
// MECHANISM:
// Drives removal through the official `claude plugin uninstall` CLI — the same
// `claude plugin …` mechanism step-9 uses to install — rather than hand-editing
// installed_plugins.json. Reading installed_plugins.json is only used to
// DISCOVER which stale plugin names exist; the actual mutation goes through the
// supported CLI so Claude Code keeps its own bookkeeping (cache dirs,
// install-counts) consistent. Best-effort cache-dir cleanup is a follow-up
// belt-and-braces step for entries Claude Code's uninstall leaves behind.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { marketplaceName, SENTINEL_PLUGIN_NAME } from './mysecond-paths.js';

/** Path to Claude Code's installed-plugins ledger. */
export function installedPluginsJsonPath(): string {
  return join(homedir(), '.claude', 'plugins', 'installed_plugins.json');
}

/** Cache dir for a single plugin under a customer marketplace. */
function pluginCacheDir(slug: string, pluginName: string): string {
  return join(
    homedir(),
    '.claude',
    'plugins',
    'cache',
    marketplaceName(slug),
    pluginName,
  );
}

export interface PrunePlan {
  /** Plugin names (not `pm-os`) found registered under this customer's marketplace. */
  stalePluginNames: string[];
  /** The marketplace name scoped to this slug — every match shares it. */
  marketplace: string;
}

/**
 * Read installed_plugins.json and determine which plugin entries are stale for
 * THIS customer's slug. A stale entry is any key `<plugin>@mysecond-customer-<slug>`
 * whose `<plugin>` is not the current expected plugin (`pm-os`).
 *
 * Soft-fails to an empty plan: a missing or corrupt ledger means there's
 * nothing we can safely prune — never throw out of the install path.
 */
export function planStalePluginPrune(slug: string): PrunePlan {
  const marketplace = marketplaceName(slug);
  const empty: PrunePlan = { stalePluginNames: [], marketplace };

  const ledgerPath = installedPluginsJsonPath();
  let raw: string;
  try {
    raw = readFileSync(ledgerPath, 'utf8');
  } catch {
    return empty; // no ledger yet (fresh machine) — nothing to prune
  }

  let parsed: { plugins?: Record<string, unknown> };
  try {
    parsed = JSON.parse(raw) as { plugins?: Record<string, unknown> };
  } catch {
    return empty; // corrupt ledger — don't risk acting on garbage
  }

  const plugins = parsed.plugins;
  if (plugins === null || plugins === undefined || typeof plugins !== 'object') {
    return empty;
  }

  // Match the EXACT marketplace suffix — `@mysecond-customer-<slug>`. This is
  // what scopes us to the customer's own slug and nothing else. A substring
  // check would be wrong (slug `t05` must not match `t0501`); we split on the
  // last `@` and compare the marketplace segment for equality.
  const suffix = `@${marketplace}`;
  const stale = new Set<string>();
  for (const key of Object.keys(plugins)) {
    if (!key.endsWith(suffix)) continue;
    const pluginName = key.slice(0, key.length - suffix.length);
    if (pluginName.length === 0) continue;
    if (pluginName === SENTINEL_PLUGIN_NAME) continue; // the current, correct plugin
    stale.add(pluginName);
  }

  return { stalePluginNames: [...stale].sort(), marketplace };
}

export interface PruneResult {
  /** Plugin names we successfully uninstalled. */
  removed: string[];
  /** Plugin names where `claude plugin uninstall` exited non-zero. */
  failed: string[];
  /** True when there was nothing to prune. */
  noop: boolean;
}

/**
 * Remove every stale `pm-*` plugin left over from the 13-plugin experiment for
 * THIS customer's slug. Idempotent: a customer who never hit the experiment
 * window has an empty plan and this is a no-op.
 *
 * Best-effort throughout — a failed uninstall is logged to `failed` but never
 * throws. The customer's `pm-os` install (the thing that actually matters)
 * already succeeded by the time this runs; stale-plugin cleanup must not be
 * able to fail the install.
 *
 * `claudeBin` is injectable for tests; defaults to the `claude` binary on PATH.
 */
export function pruneStalePlugins(
  slug: string,
  opts: { claudeBin?: string; silent?: boolean } = {},
): PruneResult {
  const claudeBin = opts.claudeBin ?? 'claude';
  const plan = planStalePluginPrune(slug);

  if (plan.stalePluginNames.length === 0) {
    return { removed: [], failed: [], noop: true };
  }

  const removed: string[] = [];
  const failed: string[] = [];

  for (const pluginName of plan.stalePluginNames) {
    const spec = `${pluginName}@${plan.marketplace}`;
    const result = spawnSync(
      claudeBin,
      ['plugin', 'uninstall', spec, '--scope', 'user'],
      { stdio: 'pipe' },
    );

    if (result.status === 0) {
      removed.push(pluginName);
    } else {
      failed.push(pluginName);
      if (opts.silent !== true) {
        const exitDisplay = result.status ?? 'ENOENT';
        process.stderr.write(
          `[mysecond] note: could not uninstall stale plugin ${spec} (exit ${exitDisplay}) — continuing.\n`,
        );
      }
    }

    // Belt-and-braces: remove the plugin's cache dir if `claude plugin
    // uninstall` left it behind (or if the ledger entry was orphaned with no
    // backing CLI state). rmSync force:true is a no-op when the dir is absent.
    try {
      const cacheDir = pluginCacheDir(slug, pluginName);
      if (existsSync(cacheDir)) {
        rmSync(cacheDir, { recursive: true, force: true });
      }
    } catch {
      // cache cleanup is purely cosmetic — never let it surface an error
    }
  }

  return { removed, failed, noop: false };
}
