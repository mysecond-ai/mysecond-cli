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

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { pluginTarball } from '../lib/api.js';
import { atomicRenameDir } from '../lib/atomic-write.js';
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
  type PluginEntry,
} from '../lib/mysecond-paths.js';
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

  // Serialize against init / other refreshes — this mutates the shared
  // marketplace dir.
  const lock = await acquireMarketplaceLock();
  try {
    // Materialize the latest tarball into the marketplace dir (mirror step-9
    // sub-steps b–e). Single attempt: on ANY failure we restore nothing and
    // leave the existing install in place (no LKG fallback — unlike first
    // install, a failed refresh isn't stranding; the old plugin still works).
    const tmpExtractDir = pluginTmpExtractDir(slug);
    const tmpMarketplaceDir = marketplaceTmpDir(slug);
    const tmpTarballPath = join(tmpMarketplaceDir, 'plugin.tgz');
    rmSync(tmpMarketplaceDir, { recursive: true, force: true });
    mkdirSync(tmpExtractDir, { recursive: true });

    let plugins: PluginEntry[];
    try {
      await fetchAndExtractPlugin(ctx, meta, tmpTarballPath, tmpExtractDir);
      plugins = listMarketplacePluginsFromExtractDir(tmpExtractDir);
      mkdirSync(join(tmpMarketplaceDir, '.claude-plugin'), { recursive: true });
      writeFileSync(
        marketplaceTmpJsonPath(slug),
        serializeMarketplaceJson(buildMarketplaceJson(slug, plugins))
      );
      atomicRenameDir(tmpMarketplaceDir, marketplaceDir(slug));
    } catch (err) {
      rmSync(tmpMarketplaceDir, { recursive: true, force: true });
      if (!ctx.silent) {
        process.stderr.write(
          `mysecond: couldn't download the latest plugin (${err instanceof Error ? err.message : String(err)}). Your current install is unchanged.\n`
        );
      }
      return 0;
    }

    // Re-register with Claude Code via the shared mechanics helper.
    const result = registerMarketplaceAndInstall({
      slug,
      plugins,
      claudeBin,
      deadlineMs: Date.now() + REFRESH_BUDGET_MS,
      silent: ctx.silent,
    });

    if (result.outcome.kind !== 'registered') {
      // Degraded: the previously-installed plugin is still present + working.
      // Do NOT advance installedPluginVersion, so a later run retries.
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

    // Success — cache as last-known-good + record the version ACTUALLY installed
    // (the latest we just fetched + registered), under the locked writer.
    cacheLastKnownGood(slug, meta.version, meta.sha256, join(marketplaceDir(slug), 'plugin'));
    await updateSyncState(ctx.rootDir, (s) => {
      s.installedPluginVersion = meta.version;
      s.lastClaudeBinPath = claudeBin;
    });

    if (!ctx.silent) {
      process.stdout.write(
        `mysecond: refreshed PM OS plugin to ${meta.version}. ` +
          'Reload Claude Code (/reload-plugins, or start a new session) to activate the updated skills + hooks.\n'
      );
    }
    return 0;
  } finally {
    await lock.release();
  }
}
