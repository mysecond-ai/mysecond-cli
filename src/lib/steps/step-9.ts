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

import { pluginTarball } from '../api.js';
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
  marketplaceDir,
  marketplaceJsonPath,
  marketplaceName,
  marketplaceTmpDir,
  marketplaceTmpJsonPath,
  pluginInstallSpec,
  pluginTmpExtractDir,
  validateSlug,
} from '../mysecond-paths.js';
import { fetchAndExtractPlugin } from '../plugin-tarball.js';
import { probeLayerOne } from '../plugin-load-detect.js';
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

  // Sub-step (e): generate marketplace.json into the tmp tree, atomic rename.
  const marketplaceJsonContent = serializeMarketplaceJson(buildMarketplaceJson(slug));
  const tmpMarketplaceJsonPath = marketplaceTmpJsonPath(slug);
  mkdirSync(join(tmpMarketplaceDir, '.claude-plugin'), { recursive: true });
  writeFileSync(tmpMarketplaceJsonPath, marketplaceJsonContent);

  // Atomic rename: tmp dir → final marketplace dir. CTO P1-2 v1.5 review:
  // atomicRenameDir handles non-empty destination cross-platform via rm+rename.
  atomicRenameDir(tmpMarketplaceDir, marketplaceDir(slug));

  // Sub-step (f): claude plugin marketplace add + claude plugin install.
  // Both verified non-interactive on Ron's Mac 2026-04-22 (DV-1).
  const addResult = spawnSync(
    'claude',
    ['plugin', 'marketplace', 'add', marketplaceDir(slug), '--scope', 'user'],
    { stdio: ctx.silent ? 'pipe' : 'inherit' }
  );
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
      if (!ctx.silent) {
        process.stdout.write(staleCacheBanner(fallback.cachedAgeHours) + '\n');
      }
      return { step: 9, outcome: { kind: 'completed' } };
    }
    throw new MysecondError(
      6,
      `claude plugin marketplace add failed (exit ${addResult.status}). Re-run \`mysecond init\` or contact support@mysecond.ai.`
    );
  }

  const installResult = spawnSync(
    'claude',
    ['plugin', 'install', pluginInstallSpec(slug), '--scope', 'user'],
    { stdio: ctx.silent ? 'pipe' : 'inherit' }
  );
  if (installResult.status !== 0) {
    throw new MysecondError(
      6,
      `claude plugin install ${pluginInstallSpec(slug)} failed (exit ${installResult.status}). Re-run \`mysecond init\` or contact support@mysecond.ai.`
    );
  }

  // Post-install filesystem probe (CTO-8 carry — re-runs step 9 next
  // invocation if plugin didn't actually land where we expect).
  const probe = probeLayerOne(slug, meta.version);
  if (!probe.found) {
    throw new MysecondError(
      6,
      `Plugin install reported success but ${marketplaceName(slug)}/pm-os/${meta.version} not in cache. Re-run \`mysecond init\` to retry.`
    );
  }

  // Cache the validated extracted tree as last-known-good.
  cacheLastKnownGood(slug, meta.version, meta.sha256, join(marketplaceDir(slug), 'plugin'));

  // Reset auth-thrash counter on success (CTO-v1.3-B3 critical).
  state.step9Auth401RetryCount = 0;
  writeSyncState(ctx.rootDir, state);

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
    cpSync(hit.source_dir, join(marketplaceTarget, 'plugin'), { recursive: true });
    mkdirSync(join(marketplaceTarget, '.claude-plugin'), { recursive: true });
    writeFileSync(
      marketplaceJsonPath(slug),
      serializeMarketplaceJson(buildMarketplaceJson(slug))
    );

    // Run marketplace add against the rehydrated dir (best-effort — if Claude
    // Code is also down or admin-restricted, this fails and we surface error).
    const result = spawnSync(
      'claude',
      ['plugin', 'marketplace', 'add', marketplaceTarget, '--scope', 'user'],
      { stdio: 'pipe' }
    );
    if (result.status !== 0) return null;

    const installResult = spawnSync(
      'claude',
      ['plugin', 'install', pluginInstallSpec(slug), '--scope', 'user'],
      { stdio: 'pipe' }
    );
    if (installResult.status !== 0) return null;

    // Probe for the cached version (which is what's now installed).
    const probe = probeLayerOne(slug, hit.version);
    if (!probe.found) return null;

    return { version: hit.version, cachedAgeHours: hit.cached_age_hours };
  } catch {
    return null;
  }
}

// existsSync re-export for test harness — explicit so vitest fixtures don't
// have to reach into node:fs separately.
export const __testing = { existsSync };
