// Step 9: Signed-URL plugin fetch + local marketplace install (Decision 0-C
// rewrite of v1.4 npm install). 6 sub-steps:
//   (a) companionFetch /plugin-tarball/{slug} → signed URL + sha256 + version
//   (b) download tarball via signed URL with cross-platform tar lib
//   (c) verify SHA-256; retry once with fresh URL on first mismatch
//   (d) extract to ~/.mysecond/marketplaces/customer-{slug}.tmp-{pid}/plugin/
//   (e) generate marketplace.json; atomic rename tmp dir → final
//   (f) shell out: claude plugin marketplace add + claude plugin install;
//       filesystem-probe health check
//
// Fallback (§6.2.B): on signed-URL fetch error, network error, or marketplace
// add failure, fall back to last-known-good cache if present.
//
// Auth-thrash circuit breaker (RT-3 + CTO-v1.3-B3): track step9Auth401RetryCount
// in sync-state across invocations; ≥3 retries → exit 8. Reset to 0 on success.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { emitTelemetry, pluginTarball } from '../api.js';
import { atomicRenameDir } from '../atomic-write.js';
import { staleCacheBanner } from '../copy.js';
import { MysecondError } from '../errors.js';
import {
  cacheLastKnownGood,
  findLastKnownGood,
} from '../last-known-good.js';
import { acquireMarketplaceLock } from '../marketplace-lock.js';
import { buildMarketplaceJson, serializeMarketplaceJson } from '../marketplace-json.js';
import {
  listMarketplacePluginsFromExtractDir,
  marketplaceDir,
  marketplaceJsonPath,
  marketplaceName,
  marketplaceTmpDir,
  marketplaceTmpJsonPath,
  pluginInstallSpec,
  pluginTmpExtractDir,
  SENTINEL_PLUGIN_NAME,
  validateSlug,
  type PluginEntry,
} from '../mysecond-paths.js';
import { fetchAndExtractPlugin } from '../plugin-tarball.js';
import { probeLayerOne } from '../plugin-load-detect.js';
import { pruneStalePlugins } from '../prune-stale-plugins.js';
import { emitStatus } from '../silent-status.js';
import { writeSyncState } from '../sync-state.js';

import type { StepFn } from './types.js';

const AUTH_THRASH_THRESHOLD = 3;

export const step9: StepFn = async ({ ctx, state, shared }) => {
  const rawSlug = shared.customerSlug ?? state.customerSlug;
  if (rawSlug === null || rawSlug === undefined || rawSlug === '') {
    throw new MysecondError(1, 'Step 9: missing customer slug (step 4 should have populated this).');
  }
  // RED-TEAM P0-2: defense-in-depth — re-validate at the path-construction
  // boundary in case the slug came from a sync-state.json written before the
  // step-4 validate landed (back-compat with prior installs).
  let slug: string;
  try {
    slug = validateSlug(rawSlug);
  } catch (err) {
    throw new MysecondError(1, err instanceof Error ? err.message : String(err));
  }

  // Auth-thrash circuit breaker check BEFORE doing anything.
  if (state.step9Auth401RetryCount >= AUTH_THRASH_THRESHOLD) {
    // RED-TEAM R2 P1-D: emit telemetry before throw so support can see this
    // even when the customer doesn't email. Fire-and-forget; never blocks.
    void emitTelemetry(ctx, 'mysecond.init.auth_thrash_detected', {
      customer_id: state.customerId ?? 'unknown',
      retry_count: state.step9Auth401RetryCount,
    });
    throw MysecondError.authThrashCircuit(state.step9Auth401RetryCount);
  }

  const lock = await acquireMarketplaceLock();
  try {
    return await doStep9(ctx, state, shared, slug);
  } finally {
    await lock.release();
  }
};

async function doStep9(
  ctx: import('../context.js').CommandContext,
  state: import('../sync-state.js').SyncState,
  shared: import('./types.js').StepContext['shared'],
  slug: string
): Promise<import('./types.js').StepResult> {
  // Fix C Step 1: measure step-9 total wall-clock so we can see how much of
  // the install time is actually consumed here. Emitted as step_9_total_timed
  // at step end (silent mode) and logged to stderr (interactive mode).
  const step9StartMs = performance.now();
  // Sub-step (a): fetch signed URL.
  let meta;
  try {
    meta = await pluginTarball(ctx, slug);
  } catch (err) {
    if (err instanceof MysecondError && err.subCode === 'invalid_key') {
      // 401 — increment circuit-breaker counter, persist, then attempt fallback.
      state.step9Auth401RetryCount += 1;
      writeSyncState(ctx.rootDir, state);
      if (state.step9Auth401RetryCount >= AUTH_THRASH_THRESHOLD) {
        throw MysecondError.authThrashCircuit(state.step9Auth401RetryCount);
      }
    }
    // Last-known-good fallback for network/5xx (NOT for auth — auth needs to
    // re-prompt). subscription_cancelled / plugin_revoked also bypass cache
    // (the customer shouldn't keep running cached content).
    if (err instanceof MysecondError && err.subCode === 'network') {
      const fallback = tryFallback(slug, state);
      if (fallback !== null) {
        shared.staleCacheUsed = { cachedAgeHours: fallback.cachedAgeHours };
        shared.pluginVersion = fallback.version;
        // RED-TEAM P0-1: reset counter on ANY successful step 9 completion,
        // including LKG fallback. Without this, customer hits 2 transient 401s,
        // both served from cache, then 1 more 401 → exit 8 forever.
        state.step9Auth401RetryCount = 0;
        writeSyncState(ctx.rootDir, state);
        // RED-TEAM R2 P1-D: telemetry for ops visibility into LKG usage.
        void emitTelemetry(ctx, 'mysecond.init.last_known_good_used', {
          customer_id: state.customerId ?? 'unknown',
          cached_version: fallback.version,
          cached_age_hours: fallback.cachedAgeHours,
          fallback_reason: 'signed_url_fetch_network_error',
        });
        if (!ctx.silent) {
          process.stdout.write(staleCacheBanner(fallback.cachedAgeHours) + '\n');
        }
        return { step: 9, outcome: { kind: 'completed' } };
      }
    }
    throw err;
  }

  shared.pluginVersion = meta.version;
  shared.pluginSha256 = meta.sha256;

  // Sub-steps (b)-(d): download to tmp tarball, verify SHA, extract to tmp dir.
  const tmpExtractDir = pluginTmpExtractDir(slug);
  const tmpMarketplaceDir = marketplaceTmpDir(slug);
  const tmpTarballPath = join(tmpMarketplaceDir, 'plugin.tgz');

  // Clean any prior stale tmp from a crashed run.
  rmSync(tmpMarketplaceDir, { recursive: true, force: true });
  mkdirSync(tmpExtractDir, { recursive: true });

  let attempt = 0;
  // Retry once on first SHA mismatch (sub-step c per spec).
  for (;;) {
    try {
      await fetchAndExtractPlugin(ctx, meta, tmpTarballPath, tmpExtractDir);
      break;
    } catch (err) {
      attempt++;
      if (attempt >= 2) {
        // Second mismatch / fetch error → cleanup + try fallback or exit 6.
        rmSync(tmpMarketplaceDir, { recursive: true, force: true });
        const fallback = tryFallback(slug, state);
        if (fallback !== null && err instanceof MysecondError && err.subCode === 'network') {
          shared.staleCacheUsed = { cachedAgeHours: fallback.cachedAgeHours };
          shared.pluginVersion = fallback.version;
          // RED-TEAM P0-1: reset counter on LKG fallback success (see above).
          state.step9Auth401RetryCount = 0;
          writeSyncState(ctx.rootDir, state);
          // RED-TEAM R2 P1-D: telemetry for SHA-mismatch fallback path.
          void emitTelemetry(ctx, 'mysecond.init.last_known_good_used', {
            customer_id: state.customerId ?? 'unknown',
            cached_version: fallback.version,
            cached_age_hours: fallback.cachedAgeHours,
            fallback_reason: 'tarball_sha_mismatch_or_extract_error',
          });
          if (!ctx.silent) {
            process.stdout.write(staleCacheBanner(fallback.cachedAgeHours) + '\n');
          }
          return { step: 9, outcome: { kind: 'completed' } };
        }
        throw err;
      }
      // Attempt 1 failed — re-fetch a fresh signed URL (the prior one may have
      // expired or been served stale by a CDN edge).
      try {
        meta = await pluginTarball(ctx, slug);
      } catch (refetchErr) {
        rmSync(tmpMarketplaceDir, { recursive: true, force: true });
        throw refetchErr;
      }
      shared.pluginVersion = meta.version;
      shared.pluginSha256 = meta.sha256;
      // Reset extract dir for the retry.
      rmSync(tmpExtractDir, { recursive: true, force: true });
      mkdirSync(tmpExtractDir, { recursive: true });
    }
  }

  // Sub-step (e): read PMO's tarball-internal marketplace.json (source of
  // truth for the multi-plugin layout), build the cli-side outer manifest
  // wrapping its plugins[], atomic rename.
  //
  // CRITICAL ORDERING (CAIO Day 5+ review): list the plugins BEFORE the
  // atomic rename. Reading from `pluginTmpExtractDir(slug)` gives us PMO's
  // tarball-internal manifest. After atomic rename + further cli operations,
  // the manifest at `marketplaceJsonPath(slug)` would be the cli-generated
  // one — which previously hardcoded a single `pm-os` entry and silently
  // dropped all 11 sub-plugins.
  let plugins: PluginEntry[];
  try {
    plugins = listMarketplacePluginsFromExtractDir(tmpExtractDir);
  } catch (err) {
    rmSync(tmpMarketplaceDir, { recursive: true, force: true });
    throw new MysecondError(
      6,
      `Couldn't read PMO marketplace manifest from extracted tarball: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const marketplaceJsonContent = serializeMarketplaceJson(buildMarketplaceJson(slug, plugins));
  const tmpMarketplaceJsonPath = marketplaceTmpJsonPath(slug);
  mkdirSync(join(tmpMarketplaceDir, '.claude-plugin'), { recursive: true });
  writeFileSync(tmpMarketplaceJsonPath, marketplaceJsonContent);

  // Atomic rename: tmp dir → final marketplace dir. CTO P1-2 v1.5 review:
  // atomicRenameDir handles non-empty destination cross-platform via rm+rename.
  atomicRenameDir(tmpMarketplaceDir, marketplaceDir(slug));

  // RED-TEAM R2 P0-D: stale-state recovery. If the customer previously ran
  // init successfully and then `rm -rf ~/.mysecond` (manual cleanup, disk
  // sweep, syncthing flap), Claude Code's user-settings still has the
  // marketplace registered pointing at the now-missing dir. `claude plugin
  // marketplace add` against the same name without first removing produces
  // undefined behavior per docs (no documented re-add-reconciles guarantee).
  // Idempotency pattern: remove first (best-effort, swallow non-zero), then
  // add. Covers both first-install (remove is no-op) and stale-pointer cases.
  spawnSync(
    'claude',
    ['plugin', 'marketplace', 'remove', marketplaceName(slug), '--scope', 'user'],
    { stdio: 'pipe' }
  );

  // Sub-step (f): claude plugin marketplace add + claude plugin install.
  // Both verified non-interactive on Ron's Mac 2026-04-22 (DV-1).
  const addResult = spawnSync(
    'claude',
    ['plugin', 'marketplace', 'add', marketplaceDir(slug), '--scope', 'user'],
    { stdio: ctx.silent ? 'pipe' : 'inherit' }
  );
  // RED-TEAM R2 P1-A: ENOENT detection. spawnSync returns status:null +
  // error.code='ENOENT' when the binary isn't on PATH (nvm + fish, login vs
  // non-login shell, custom PATH ordering). Without this check, we'd report
  // "exit null" which is meaningless to a customer and routes the failure
  // through the LKG fallback path (which also can't find claude).
  if (addResult.error !== undefined && (addResult.error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new MysecondError(
      6,
      "Cannot find 'claude' binary on PATH. Make sure Claude Code is installed and `which claude` resolves in this terminal. If you use nvm + a non-bash shell, try: `npm install -g @mysecond/cli` from the same shell where `which claude` works."
    );
  }
  if (addResult.status !== 0) {
    // Try last-known-good fallback if marketplace add fails (e.g., Claude Code
    // version mismatch or transient marketplace state).
    const fallback = tryFallback(slug, state);
    if (fallback !== null) {
      shared.staleCacheUsed = { cachedAgeHours: fallback.cachedAgeHours };
      shared.pluginVersion = fallback.version;
      // RED-TEAM P0-1: reset counter on LKG fallback success.
      state.step9Auth401RetryCount = 0;
      writeSyncState(ctx.rootDir, state);
      // RED-TEAM R2 P1-D: telemetry for marketplace-add-failure fallback path.
      void emitTelemetry(ctx, 'mysecond.init.last_known_good_used', {
        customer_id: state.customerId ?? 'unknown',
        cached_version: fallback.version,
        cached_age_hours: fallback.cachedAgeHours,
        fallback_reason: 'claude_marketplace_add_failed',
      });
      if (!ctx.silent) {
        process.stdout.write(staleCacheBanner(fallback.cachedAgeHours) + '\n');
      }
      return { step: 9, outcome: { kind: 'completed' } };
    }
    const exitDisplay = addResult.status ?? 'ENOENT';
    throw new MysecondError(
      6,
      `claude plugin marketplace add failed (exit ${exitDisplay}). Re-run \`mysecond init\` or contact support@mysecond.ai.`
    );
  }

  // Install loop over all sub-plugins from PMO's marketplace. Today
  // there's only one plugin (`pm-os`); the loop is preserved for the
  // multi-plugin future. Tracks failures; hard-fails on the sentinel
  // (`pm-os` itself) since that's the entire install — non-sentinel
  // failures degrade gracefully.
  const failedPlugins: string[] = [];
  for (let pluginIdx = 0; pluginIdx < plugins.length; pluginIdx++) {
    // plugins[] is bounded by the loop condition; the non-null assertion is safe.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const plugin = plugins[pluginIdx]!;
    const spec = pluginInstallSpec(slug, plugin.name);
    // Fix C Step 1: per-plugin wall-clock measurement. We want to see
    // which plugin(s) are slow before deciding whether to parallelize.
    const pluginStartMs = performance.now();
    const installResult = spawnSync(
      'claude',
      ['plugin', 'install', spec, '--scope', 'user'],
      { stdio: ctx.silent ? 'pipe' : 'inherit' }
    );
    const pluginDurationMs = Math.round(performance.now() - pluginStartMs);

    // Fix C Step 1: emit per-plugin timing in silent mode.
    emitStatus({
      kind: 'plugin_install_timed',
      plugin: plugin.name,
      duration_ms: pluginDurationMs,
      exit_code: installResult.status ?? -1,
      plugin_index: pluginIdx,
      plugin_total: plugins.length,
    });

    // Fix C Step 1: write progress to stderr in interactive mode so a
    // terminal user can see real-time progress without contaminating the
    // JSON event stream on stdout.
    if (!ctx.silent) {
      const durationSec = Math.round(pluginDurationMs / 1000);
      process.stderr.write(
        `[mysecond] Installed ${plugin.name} in ${durationSec}s (${pluginIdx + 1}/${plugins.length})\n`
      );
    }

    // ENOENT on the binary is fatal regardless of which plugin in the loop
    // hit it — PATH issue affects every plugin install.
    if (installResult.error !== undefined && (installResult.error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new MysecondError(
        6,
        "Cannot find 'claude' binary on PATH (between marketplace add + plugin install). Re-run `mysecond init` from the same shell where `which claude` works."
      );
    }
    if (installResult.status !== 0) {
      failedPlugins.push(plugin.name);
      // Single-plugin era: `claude plugin install` exit code is the
      // authoritative signal. A non-zero exit on the only plugin (`pm-os`)
      // means the install genuinely failed — surface a clear error.
      if (plugin.name === SENTINEL_PLUGIN_NAME) {
        const exitDisplay = installResult.status ?? 'ENOENT';
        throw new MysecondError(
          6,
          `claude plugin install ${spec} failed (exit ${exitDisplay}). Re-run \`mysecond init\` or contact support@mysecond.ai.`
        );
      }
      // Non-sentinel failure: warn and continue. Customer's success box at
      // step-13 reflects partial install via shared.failedPlugins.
      if (!ctx.silent) {
        process.stderr.write(
          `  ⚠ skipped ${plugin.name} (claude plugin install exited ${installResult.status ?? 'ENOENT'})\n`
        );
      }
    }
  }

  // Surface partial-install state to step-13 for the success box.
  if (failedPlugins.length > 0) {
    shared.failedPlugins = failedPlugins;
  }

  // Make the install REPLACING, not additive (Finding #2 — "duplicate skills").
  // During the 2026-05-04→05 multi-category experiment, customers were
  // installed as 13 separately-named `pm-*` plugins under their marketplace.
  // The cli install path never uninstalls prior plugins, so a customer who
  // onboarded in that window and later re-synced now has BOTH the 13 stale
  // plugins AND `pm-os` — every skill appears twice (correct flat name +
  // abandoned `pm-data:`-prefixed leftover). Uninstall any non-`pm-os` plugin
  // registered under THIS customer's own marketplace. Scoped strictly to the
  // customer's slug; best-effort — never fails the install (pm-os already
  // landed above). No-op for customers who never hit the experiment window.
  try {
    const prune = pruneStalePlugins(slug, { silent: ctx.silent });
    if (!prune.noop) {
      emitStatus({
        kind: 'stale_plugins_pruned',
        removed: prune.removed,
        failed: prune.failed,
      });
      if (!ctx.silent && prune.removed.length > 0) {
        process.stderr.write(
          `[mysecond] Removed ${prune.removed.length} stale plugin(s) from a prior install: ${prune.removed.join(', ')}\n`
        );
      }
    }
  } catch (err) {
    // Defense-in-depth: pruneStalePlugins is already best-effort internally,
    // but an unexpected throw must never abort a successful install.
    if (!ctx.silent) {
      process.stderr.write(
        `[mysecond] note: stale-plugin cleanup skipped (${err instanceof Error ? err.message : String(err)})\n`
      );
    }
  }

  // Post-install filesystem probe — informational only. The install
  // command's exit code (checked above) is the authoritative success
  // signal. The probe is best-effort verification that pm-os landed in
  // the cache directory we expect; if it doesn't (different cache path,
  // version mismatch, race), we log to stderr and continue. Throwing
  // here previously false-alarmed with exit 6 even on healthy installs.
  const probe = probeLayerOne(slug, null, SENTINEL_PLUGIN_NAME);
  if (!probe.found && !ctx.silent) {
    process.stderr.write(
      `[mysecond] note: plugin cache probe for ${marketplaceName(slug)}/${SENTINEL_PLUGIN_NAME} did not match — install reported success, continuing.\n`
    );
  }

  // Cache the validated extracted tree as last-known-good.
  cacheLastKnownGood(slug, meta.version, meta.sha256, join(marketplaceDir(slug), 'plugin'));

  // Reset auth-thrash counter on success (CTO-v1.3-B3 critical).
  state.step9Auth401RetryCount = 0;
  writeSyncState(ctx.rootDir, state);

  // Fix C Step 1: emit step-level total timing. Includes everything from
  // signed-URL fetch through plugin probe — the full wall-clock the customer
  // is waiting for. Emitted in silent mode as step_9_total_timed JSON event.
  const step9DurationMs = Math.round(performance.now() - step9StartMs);
  emitStatus({
    kind: 'step_9_total_timed',
    duration_ms: step9DurationMs,
    plugin_count: plugins.length,
    failed_count: failedPlugins.length,
  });
  // Also write to stderr in interactive mode so the terminal user can see
  // the total plugin-install phase time without grepping stdout JSON.
  if (!ctx.silent) {
    process.stderr.write(
      `[mysecond] Plugin install phase complete: ${plugins.length} plugins in ${Math.round(step9DurationMs / 1000)}s (${failedPlugins.length} failed)\n`
    );
  }

  return { step: 9, outcome: { kind: 'completed' } };
}

// Try to rehydrate the last-known-good cached version into the marketplace
// dir. Returns metadata on hit, null on miss. Caller decides whether to
// surface this to the customer.
function tryFallback(
  slug: string,
  _state: import('../sync-state.js').SyncState
): { version: string; cachedAgeHours: number } | null {
  const hit = findLastKnownGood(slug);
  if (hit === null) return null;

  // Rehydrate: copy cached version into marketplace dir (so claude plugin
  // marketplace add works against it). This is a synchronous best-effort
  // rebuild — if it throws, fallback is treated as a miss.
  try {
    const marketplaceTarget = marketplaceDir(slug);
    rmSync(marketplaceTarget, { recursive: true, force: true });
    mkdirSync(marketplaceTarget, { recursive: true });
    // Copy the cached plugin tree into ./plugin/ + write a fresh marketplace.json.
    const restoredPluginDir = join(marketplaceTarget, 'plugin');
    cpSync(hit.source_dir, restoredPluginDir, { recursive: true });

    // Workstream B Day 5+: read PMO's manifest from the restored ./plugin/
    // tree (mirrors step-9 main path) to populate the cli-side outer
    // marketplace.json. Without this, the CTO-flagged fallback bug ships
    // the legacy single `pm-os` shape and customers restored from LKG
    // never get the multi-plugin install.
    let plugins: PluginEntry[];
    try {
      plugins = listMarketplacePluginsFromExtractDir(restoredPluginDir);
    } catch {
      // LKG cache predates the multi-plugin manifest — can't restore safely
      // without the plugins list. Treat as miss; main path will refetch
      // (or surface its own error if network down too).
      return null;
    }
    mkdirSync(join(marketplaceTarget, '.claude-plugin'), { recursive: true });
    writeFileSync(
      marketplaceJsonPath(slug),
      serializeMarketplaceJson(buildMarketplaceJson(slug, plugins))
    );

    // Run marketplace add against the rehydrated dir (best-effort — if Claude
    // Code is also down or admin-restricted, this fails and we surface error).
    const result = spawnSync(
      'claude',
      ['plugin', 'marketplace', 'add', marketplaceTarget, '--scope', 'user'],
      { stdio: 'pipe' }
    );
    if (result.status !== 0) return null;

    // Install loop over the LKG plugins. Same sentinel-fail-hard semantics
    // as the main path: `pm-os` MUST install for fallback to count.
    for (const plugin of plugins) {
      const installResult = spawnSync(
        'claude',
        ['plugin', 'install', pluginInstallSpec(slug, plugin.name), '--scope', 'user'],
        { stdio: 'pipe' }
      );
      if (installResult.status !== 0 && plugin.name === SENTINEL_PLUGIN_NAME) {
        return null;
      }
      // Non-sentinel install failures during fallback are silent — customer
      // is already in the degraded "stale cache" state and the banner explains.
    }

    // Probe for the sentinel plugin by name only (version-agnostic — Claude Code
    // installs at plugin.json version which may differ from the cached version).
    const probe = probeLayerOne(slug, null, SENTINEL_PLUGIN_NAME);
    if (!probe.found) return null;

    return { version: hit.version, cachedAgeHours: hit.cached_age_hours };
  } catch {
    return null;
  }
}

// existsSync re-export for test harness — explicit so vitest fixtures don't
// have to reach into node:fs separately.
export const __testing = { existsSync };
