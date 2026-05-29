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
// `claude plugin uninstall` any whose plugin name is one of the 13 KNOWN
// experiment plugins (the EXPERIMENT_PLUGINS allowlist below). The per-customer
// marketplace registration itself is preserved — `pm-os` still needs it. Only
// the orphaned individual plugin entries are removed.
//
// SAFETY — defense in depth (Codex adversarial review, cli#32):
//   1. validateSlug() — the slug flows into filesystem paths + the marketplace
//      suffix match. A corrupt sync-state.json slug (the `sync` SessionStart
//      path does NOT pre-validate) must not reach path construction. Invalid
//      slug → no-op, never throw.
//   2. EXPERIMENT_PLUGINS allowlist — we only ever uninstall one of the 13
//      KNOWN stale plugin names. A legitimate future plugin, a beta, a support
//      plugin, or a malformed ledger entry under the customer marketplace is
//      left untouched. "Not pm-os" is NOT sufficient — the name must be on the
//      allowlist.
//   3. isPlainPluginToken() — even an allowlist member is re-validated as a
//      plain plugin-name token (no `/`, no `..`, no `@`) before it is used as
//      a `claude plugin uninstall` arg OR an rmSync() path segment. A malformed
//      ledger key like `../../cache/.../vercel@mysecond-customer-<slug>` passes
//      a naive endsWith() suffix check; without this guard `join()` would
//      normalize the `..` and rmSync would delete OUTSIDE the customer's cache.
//   4. Exact marketplace-suffix match — scopes strictly to the customer's own
//      slug. `t05` must not match `t0501`; never touches other customers,
//      other marketplaces (playwright@claude-plugins-official), or pm-os.
//   5. Lock around the Claude plugin dir — `sync` runs on every SessionStart,
//      so two concurrent Claude sessions can race the same prune. We serialize
//      on `~/.claude/plugins/` and treat "already gone" as success.
//
// MECHANISM:
// Drives removal through the official `claude plugin uninstall` CLI — the same
// `claude plugin …` mechanism step-9 uses to install — rather than hand-editing
// installed_plugins.json. Reading installed_plugins.json is only used to
// DISCOVER which stale plugin names exist; the actual mutation goes through the
// supported CLI so Claude Code keeps its own bookkeeping (cache dirs,
// install-counts) consistent. Cache-dir cleanup runs ONLY after a confirmed
// successful uninstall — never on the failure path (a deleted cache dir behind
// a still-registered ledger entry breaks Claude startup).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import lockfile from 'proper-lockfile';

import { resolveClaudeBin } from './claude-bin.js';
import { marketplaceName, validateSlug } from './mysecond-paths.js';

/**
 * The 13 stale plugin names from the 2026-05-04→05 multi-category experiment.
 * THIS IS THE ALLOWLIST — `pruneStalePlugins` only ever uninstalls a name that
 * is BOTH on this list AND registered under the customer's own marketplace.
 * Any other plugin under the marketplace (a future plugin, a beta, the current
 * `pm-os`, a malformed ledger entry) is left strictly untouched.
 *
 * Frozen so a caller can't mutate the allowlist at runtime.
 */
export const EXPERIMENT_PLUGINS: readonly string[] = Object.freeze([
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
]);

const EXPERIMENT_PLUGIN_SET = new Set<string>(EXPERIMENT_PLUGINS);

/**
 * Conservative plain-plugin-name token check. An allowlist member should always
 * pass this — it is a belt-and-suspenders guard against a malformed ledger key
 * smuggling path-traversal (`..`), path separators (`/`), or a marketplace
 * delimiter (`@`) into a value that is then used as BOTH a `claude plugin
 * uninstall` argument AND an `rmSync` path segment. Lowercase alphanumerics +
 * hyphens only; must start with an alphanumeric.
 */
function isPlainPluginToken(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(name);
}

/** spawnSync timeout for `claude plugin uninstall` — a stuck uninstall must
 *  not hang `mysecond sync` on every SessionStart. Timeout → treated as a
 *  non-fatal failure (the plugin stays; next sync retries). */
const UNINSTALL_TIMEOUT_MS = 30_000;

/**
 * proper-lockfile stale window for the Claude-plugin-dir lock.
 *
 * This must comfortably EXCEED the worst-case synchronous critical section.
 * The critical section runs blocking `spawnSync()` in a loop over up to
 * `EXPERIMENT_PLUGINS.length` plugins, each capped at `UNINSTALL_TIMEOUT_MS`.
 * While `spawnSync()` blocks the event loop, proper-lockfile's heartbeat timer
 * CANNOT fire to refresh the lock's mtime — so if the stale window were merely
 * 30s (one uninstall), a second concurrent `mysecond sync` (every SessionStart)
 * would treat the still-held lock as stale and steal it mid-prune.
 *
 * Worst case = every uninstall hangs to its full timeout: 13 × 30s = 390s.
 * Add a 60s margin for ledger reads, rmSync, and process scheduling jitter.
 * Computed from the two source constants so it stays correct if either changes.
 *
 * The prune is best-effort + idempotent (plan re-read inside the lock,
 * "already gone" = success), so a stolen lock would only cause harmless
 * redundant uninstall attempts — but a stale window this size makes it
 * airtight regardless.
 */
const LOCK_STALE_MS = EXPERIMENT_PLUGINS.length * UNINSTALL_TIMEOUT_MS + 60_000;
const LOCK_RETRIES = 5;
const LOCK_MIN_TIMEOUT_MS = 100;

/** Path to Claude Code's installed-plugins ledger. */
export function installedPluginsJsonPath(): string {
  return join(homedir(), '.claude', 'plugins', 'installed_plugins.json');
}

/** The `~/.claude/plugins/` dir — lock anchor + cache parent. */
function claudePluginsDir(): string {
  return join(homedir(), '.claude', 'plugins');
}

/**
 * Cache dir for a single plugin under a customer marketplace.
 * Caller MUST have already validated `slug` (validateSlug) and `pluginName`
 * (isPlainPluginToken) — this function does no validation of its own.
 */
function pluginCacheDir(slug: string, pluginName: string): string {
  return join(
    claudePluginsDir(),
    'cache',
    marketplaceName(slug),
    pluginName,
  );
}

export interface PrunePlan {
  /** Stale experiment-plugin names found registered under this customer's marketplace. */
  stalePluginNames: string[];
  /** The marketplace name scoped to this slug — every match shares it. */
  marketplace: string;
}

/**
 * Read installed_plugins.json and determine which plugin entries are stale for
 * THIS customer's slug. A stale entry is any key `<plugin>@mysecond-customer-<slug>`
 * whose `<plugin>` is on the EXPERIMENT_PLUGINS allowlist AND is a plain
 * plugin-name token.
 *
 * `slug` is validated here (validateSlug) — an invalid slug yields an empty
 * plan with `marketplace: ''` rather than throwing or constructing a path.
 *
 * Soft-fails to an empty plan: a missing/corrupt ledger, an invalid slug, or
 * no matching entries all mean "nothing to safely prune" — never throw out of
 * the install/sync path.
 */
export function planStalePluginPrune(slug: string): PrunePlan {
  // P0-2: validate the slug HERE — don't trust the caller. The `sync`
  // SessionStart path passes state.customerSlug straight from a possibly
  // stale/corrupt sync-state.json with no prior validateSlug().
  let safeSlug: string;
  try {
    safeSlug = validateSlug(slug);
  } catch {
    return { stalePluginNames: [], marketplace: '' };
  }

  const marketplace = marketplaceName(safeSlug);
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
  // check would be wrong (slug `t05` must not match `t0501`); we slice off the
  // exact suffix and compare the remaining plugin-name segment.
  const suffix = `@${marketplace}`;
  const stale = new Set<string>();
  for (const key of Object.keys(plugins)) {
    if (!key.endsWith(suffix)) continue;
    const pluginName = key.slice(0, key.length - suffix.length);
    if (pluginName.length === 0) continue;
    // P0-3: allowlist — only the 13 KNOWN experiment plugins are pruned.
    if (!EXPERIMENT_PLUGIN_SET.has(pluginName)) continue;
    // P0-1: even an allowlist member is re-validated as a plain token before
    // it can become a filesystem path segment or a CLI argument. (An allowlist
    // member always passes this; it's defense in depth against a future
    // allowlist edit introducing a non-token value.)
    if (!isPlainPluginToken(pluginName)) continue;
    stale.add(pluginName);
  }

  return { stalePluginNames: [...stale].sort(), marketplace };
}

export interface PruneResult {
  /** Plugin names we successfully uninstalled. */
  removed: string[];
  /** Plugin names where `claude plugin uninstall` failed (non-zero / timeout / ENOENT). */
  failed: string[];
  /** True when there was nothing to prune (empty plan, invalid slug, or lock contention). */
  noop: boolean;
}

const NOOP: PruneResult = { removed: [], failed: [], noop: true };

/**
 * Acquire a lock on `~/.claude/plugins/` so two concurrent Claude sessions
 * (each firing `mysecond sync` on SessionStart) don't race the same prune.
 * Returns a release fn, or `null` if the lock can't be acquired — in which
 * case the caller treats the prune as a no-op (another process is handling it,
 * or will on the next sync). Best-effort: never throws.
 */
async function acquirePluginDirLock(): Promise<(() => Promise<void>) | null> {
  const dir = claudePluginsDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }
  try {
    return await lockfile.lock(dir, {
      retries: { retries: LOCK_RETRIES, minTimeout: LOCK_MIN_TIMEOUT_MS },
      stale: LOCK_STALE_MS,
    });
  } catch {
    // Lock contention or a corrupt lockfile — skip this prune cycle. The
    // holder is handling it, or the next sync will.
    return null;
  }
}

/**
 * Remove every stale experiment plugin left over from the 13-plugin experiment
 * for THIS customer's slug. Idempotent: a customer who never hit the experiment
 * window has an empty plan and this is a no-op.
 *
 * Async because it serializes on a `~/.claude/plugins/` lock (P1-5) — the
 * `sync` SessionStart path can run concurrently across Claude sessions.
 *
 * Best-effort throughout — a failed uninstall is logged to `failed` but never
 * throws. The customer's `pm-os` install (the thing that actually matters)
 * already succeeded by the time this runs; stale-plugin cleanup must not be
 * able to fail the install or the sync.
 *
 * `claudeBin` is injectable for tests; defaults to the `claude` binary on PATH.
 */
export async function pruneStalePlugins(
  slug: string,
  opts: { claudeBin?: string; silent?: boolean } = {},
): Promise<PruneResult> {
  const claudeBin = opts.claudeBin ?? resolveClaudeBin().path;

  // planStalePluginPrune validates the slug + applies the allowlist + token
  // guard. An invalid slug / corrupt ledger / no matches all yield an empty
  // plan here.
  const plan = planStalePluginPrune(slug);
  if (plan.stalePluginNames.length === 0) {
    return NOOP;
  }

  // P1-5: serialize on the Claude plugin dir. If we can't get the lock,
  // another process is pruning (or will) — treat as a clean no-op.
  const release = await acquirePluginDirLock();
  if (release === null) {
    return NOOP;
  }

  const removed: string[] = [];
  const failed: string[] = [];

  try {
    // Re-read the plan INSIDE the lock — between planning above and acquiring
    // the lock, a concurrent process may have already pruned some/all entries.
    // "Already gone" is success, not failure.
    const lockedPlan = planStalePluginPrune(slug);
    if (lockedPlan.stalePluginNames.length === 0) {
      return NOOP;
    }

    for (const pluginName of lockedPlan.stalePluginNames) {
      // Defense in depth: the plan already token-checked + allowlisted, but
      // re-assert before BOTH the CLI call and the rmSync. Cheap; closes any
      // gap if planStalePluginPrune is ever refactored.
      if (
        !EXPERIMENT_PLUGIN_SET.has(pluginName) ||
        !isPlainPluginToken(pluginName)
      ) {
        continue;
      }

      const spec = `${pluginName}@${lockedPlan.marketplace}`;
      const result = spawnSync(
        claudeBin,
        ['plugin', 'uninstall', spec, '--scope', 'user'],
        { stdio: 'pipe', timeout: UNINSTALL_TIMEOUT_MS },
      );

      // spawnSync sets signal:'SIGTERM' (and status:null) on a timeout kill.
      const timedOut =
        result.signal === 'SIGTERM' ||
        (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
      const succeeded = result.status === 0 && !timedOut;

      if (succeeded) {
        removed.push(pluginName);

        // P1-4: cache cleanup runs ONLY after a confirmed-successful uninstall.
        // Deleting the cache dir while the ledger entry still points at it
        // would break Claude startup. rmSync force:true is a no-op when the
        // dir is already absent (e.g. Claude's uninstall already removed it).
        try {
          const cacheDir = pluginCacheDir(slug, pluginName);
          if (existsSync(cacheDir)) {
            rmSync(cacheDir, { recursive: true, force: true });
          }
        } catch {
          // cache cleanup is purely cosmetic — never let it surface an error
        }
      } else {
        failed.push(pluginName);
        if (opts.silent !== true) {
          const reason = timedOut
            ? `timed out after ${UNINSTALL_TIMEOUT_MS}ms`
            : `exit ${result.status ?? 'ENOENT'}`;
          process.stderr.write(
            `[mysecond] note: could not uninstall stale plugin ${spec} (${reason}) — continuing.\n`,
          );
        }
      }
    }
  } finally {
    try {
      await release();
    } catch {
      // proper-lockfile auto-releases stale locks after LOCK_STALE_MS anyway.
    }
  }

  if (removed.length === 0 && failed.length === 0) {
    return NOOP;
  }
  return { removed, failed, noop: false };
}
