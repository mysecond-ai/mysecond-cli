// `mysecond plugin-refresh` — re-install the latest published plugin version so
// an ALREADY-installed customer picks up new hooks / skills. Claude Code caches
// the installed plugin and does NOT auto-update a local-directory marketplace,
// and `mysecond sync` never re-installs the plugin — so a hook change shipped
// via regen reaches existing installs only when something re-fetches + re-runs
// `claude plugin install`. That "something" is this command.
//
// Run once per existing customer after a hook/plugin change ships. New installs
// always pull the latest plugin at `init`, so they never need this. Currently
// MANUAL / support-invoked — NOT auto-wired into the SessionStart hook (that
// self-healing pipeline is the deferred "Option C").
//
// Best-effort + non-fatal: on ANY failure (no auth, network down, Claude Code
// unavailable) it leaves the currently-installed plugin untouched and exits 0.
// The only durable change on success is re-installing the latest plugin and
// recording installedPluginVersion.

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { pluginTarball } from '../lib/api.js';
import { resolveClaudeBin } from '../lib/claude-bin.js';
import type { CommandContext } from '../lib/context.js';
import { cacheLastKnownGood } from '../lib/last-known-good.js';
import {
  buildMarketplaceJson,
  serializeMarketplaceJson,
} from '../lib/marketplace-json.js';
import { acquireMarketplaceLock } from '../lib/marketplace-lock.js';
import {
  listMarketplacePluginsFromExtractDir,
  marketplaceDir,
  marketplaceTmpDir,
  marketplaceTmpJsonPath,
  pluginTmpExtractDir,
  validateSlug,
} from '../lib/mysecond-paths.js';
import { readInstalledPluginContractVersion } from '../lib/plugin-meta.js';
import { registerMarketplaceAndInstall } from '../lib/plugin-register.js';
import { fetchAndExtractPlugin } from '../lib/plugin-tarball.js';
import { readSyncState, updateSyncState } from '../lib/sync-state.js';

// Single shared wall-clock budget for the registration spawns — mirror step-9's
// REGISTER_BUDGET_MS so a wedged `claude` degrades fast instead of freezing.
const REFRESH_BUDGET_MS = 30_000;

export async function runPluginRefresh(
  _args: readonly string[],
  ctx: CommandContext
): Promise<number> {
  if (ctx.apiKey.length === 0) {
    if (!ctx.silent) {
      process.stderr.write('mysecond: not authenticated — run `mysecond init` first.\n');
    }
    return 0;
  }

  const state = readSyncState(ctx.rootDir);
  const rawSlug = state.customerSlug;
  if (rawSlug === null || rawSlug === undefined || rawSlug === '') {
    if (!ctx.silent) {
      process.stderr.write('mysecond: no install found to refresh — run `mysecond init` first.\n');
    }
    return 0;
  }
  let slug: string;
  try {
    slug = validateSlug(rawSlug);
  } catch {
    return 0; // corrupt slug in sync-state — nothing safe to do
  }

  // What version is available? Any error here (network/auth/revoked) leaves the
  // working install in place — we just try again next time.
  let meta: Awaited<ReturnType<typeof pluginTarball>>;
  try {
    meta = await pluginTarball(ctx, slug);
  } catch (err) {
    if (!ctx.silent) {
      process.stderr.write(
        `mysecond: couldn't check for a plugin update (${err instanceof Error ? err.message : String(err)}). Your current install is unchanged.\n`
      );
    }
    return 0;
  }

  // Already current? `installedPluginVersion === null` means a pre-feature
  // install whose materialized version we don't know — refresh once to
  // self-heal. `--force-update` always re-installs.
  if (
    !ctx.forceUpdate &&
    state.installedPluginVersion !== null &&
    state.installedPluginVersion === meta.version
  ) {
    if (!ctx.silent) {
      process.stdout.write(`mysecond: plugin already up to date (${meta.version}).\n`);
    }
    return 0;
  }

  const claudeBin = resolveClaudeBin({ persistedPath: state.lastClaudeBinPath }).path;

  // Serialize against init / other refreshes (this mutates the shared
  // marketplace dir). acquireMarketplaceLock THROWS on contention/FS error, so
  // guard it — the command must stay best-effort / exit 0. If another mysecond
  // process holds the lock, skip; a later run retries.
  let lock: { release: () => Promise<void> };
  try {
    lock = await acquireMarketplaceLock();
  } catch {
    if (!ctx.silent) {
      process.stderr.write(
        'mysecond: another mysecond process is busy; skipping plugin refresh (will retry later).\n'
      );
    }
    return 0;
  }

  const tmpMarketplaceDir = marketplaceTmpDir(slug);
  try {
    // Materialize the latest tarball (mirror step-9 sub-steps b–e). No LKG
    // fallback — unlike first install, a failed refresh isn't stranding: the
    // already-installed plugin keeps working, so on ANY failure (outer catch)
    // we leave it untouched and exit 0.
    const tmpExtractDir = pluginTmpExtractDir(slug);
    const tmpTarballPath = join(tmpMarketplaceDir, 'plugin.tgz');
    rmSync(tmpMarketplaceDir, { recursive: true, force: true });
    mkdirSync(tmpExtractDir, { recursive: true });

    await fetchAndExtractPlugin(ctx, meta, tmpTarballPath, tmpExtractDir);
    // Byte-accurate: read the contract version from the bytes we just extracted
    // (not the server response), so what we record == what's actually installed.
    const installedContractVersion = readInstalledPluginContractVersion(tmpExtractDir);
    const plugins = listMarketplacePluginsFromExtractDir(tmpExtractDir);
    mkdirSync(join(tmpMarketplaceDir, '.claude-plugin'), { recursive: true });
    writeFileSync(
      marketplaceTmpJsonPath(slug),
      serializeMarketplaceJson(buildMarketplaceJson(slug, plugins))
    );

    // Safe swap — NOT atomicRenameDir, which rm's the destination BEFORE the
    // rename and would destroy the customer's working marketplace source if the
    // rename then failed. Move the old dir aside, move the new one in, drop the
    // old — and restore the old if the rename fails. The marketplace dir is
    // never left missing. All paths share a parent, so renameSync is atomic.
    // Fixed `.bak` name (not pid-suffixed): the marketplace lock serializes
    // refreshes so there's no collision, and the leading rmSync clears any stale
    // backup a previously-crashed swap left behind (a pid suffix would orphan).
    const finalDir = marketplaceDir(slug);
    const backupDir = `${finalDir}.bak`;
    const hadExisting = existsSync(finalDir);
    rmSync(backupDir, { recursive: true, force: true });
    if (hadExisting) renameSync(finalDir, backupDir);
    try {
      renameSync(tmpMarketplaceDir, finalDir);
    } catch (renameErr) {
      if (hadExisting) renameSync(backupDir, finalDir);
      throw renameErr;
    }
    if (hadExisting) rmSync(backupDir, { recursive: true, force: true });

    // Re-register with Claude Code via the shared mechanics helper.
    const result = registerMarketplaceAndInstall({
      slug,
      plugins,
      claudeBin,
      deadlineMs: Date.now() + REFRESH_BUDGET_MS,
      silent: ctx.silent,
    });

    if (result.outcome.kind !== 'registered') {
      // Degraded: the marketplace dir now holds the new tree but Claude Code
      // didn't (re)install it. The previously-installed cached plugin still
      // works. Do NOT advance installedPluginVersion, so a later run retries.
      if (!ctx.silent) {
        const why =
          result.outcome.kind === 'binary_not_found'
            ? "couldn't run the Claude Code CLI — re-open Claude Code, then retry"
            : result.outcome.kind === 'timed_out'
              ? 'Claude Code took too long to respond'
              : result.outcome.reason;
        process.stderr.write(
          `mysecond: plugin refresh didn't complete (${why}). Your current install still works.\n`
        );
      }
      return 0;
    }

    // Record the version ACTUALLY installed FIRST (the durable, important
    // persist), THEN cache last-known-good best-effort — a cache write failure
    // must not make a successful refresh exit non-zero or lose the version.
    // retries: 10 — this is the one durable, important write (it gates whether a
    // future refresh needlessly re-installs). plugin-refresh is rare + not a hot
    // path, so it waits out contention rather than fast-skipping like the hooks.
    await updateSyncState(
      ctx.rootDir,
      (s) => {
        s.installedPluginVersion = meta.version;
        s.installedPluginContractVersion = installedContractVersion;
        s.lastClaudeBinPath = claudeBin;
      },
      { retries: 10 }
    );
    try {
      cacheLastKnownGood(slug, meta.version, meta.sha256, join(finalDir, 'plugin'));
    } catch {
      // best-effort cache; the refresh already succeeded + recorded the version.
    }

    if (!ctx.silent) {
      process.stdout.write(
        `mysecond: refreshed PM OS plugin to ${meta.version}. ` +
          'Reload Claude Code (/reload-plugins, or start a new session) to activate the updated skills + hooks.\n'
      );
    }
    return 0;
  } catch (err) {
    // Any unexpected failure (download, swap, register, persist) — clean up tmp,
    // leave the working install in place, exit 0. Refresh is best-effort.
    rmSync(tmpMarketplaceDir, { recursive: true, force: true });
    if (!ctx.silent) {
      process.stderr.write(
        `mysecond: plugin refresh didn't complete (${err instanceof Error ? err.message : String(err)}). Your current install is unchanged.\n`
      );
    }
    return 0;
  } finally {
    await lock.release().catch(() => {});
  }
}
