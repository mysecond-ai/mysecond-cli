// `~/.mysecond/...` path helpers — the mySecond-managed dir per Decision 0-C.
// Cross-platform via `os.homedir()` + `path.join()` (guardrail #4 — never `/` or `~`).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MYSECOND_HOME_DIRNAME = '.mysecond';

export function mysecondHome(): string {
  return join(homedir(), MYSECOND_HOME_DIRNAME);
}

export function marketplacesRoot(): string {
  return join(mysecondHome(), 'marketplaces');
}

// Final marketplace dir: `~/.mysecond/marketplaces/customer-{slug}/`
// Spec §6.7b chose this local naming (no `mysecond-` prefix on the local dir).
export function marketplaceDir(slug: string): string {
  return join(marketplacesRoot(), `customer-${slug}`);
}

// Tmp marketplace dir for atomic write: `~/.mysecond/marketplaces/customer-{slug}.tmp-{pid}/`
export function marketplaceTmpDir(slug: string, pid: number = process.pid): string {
  return join(marketplacesRoot(), `customer-${slug}.tmp-${pid}`);
}

// `.claude-plugin/marketplace.json` lives inside the marketplace dir.
export function marketplaceJsonPath(slug: string): string {
  return join(marketplaceDir(slug), '.claude-plugin', 'marketplace.json');
}

export function marketplaceTmpJsonPath(slug: string, pid: number = process.pid): string {
  return join(marketplaceTmpDir(slug, pid), '.claude-plugin', 'marketplace.json');
}

// Extracted plugin tree path inside marketplace dir (matches §6.7b plugins[].source = "./plugin").
export function pluginExtractDir(slug: string): string {
  return join(marketplaceDir(slug), 'plugin');
}

export function pluginTmpExtractDir(slug: string, pid: number = process.pid): string {
  return join(marketplaceTmpDir(slug, pid), 'plugin');
}

// Last-known-good cache root: `~/.mysecond/cache/last-known-good/`
export function lastKnownGoodRoot(): string {
  return join(mysecondHome(), 'cache', 'last-known-good');
}

export function lastKnownGoodCustomerRoot(slug: string): string {
  return join(lastKnownGoodRoot(), `customer-${slug}`);
}

export function lastKnownGoodVersionDir(slug: string, version: string): string {
  return join(lastKnownGoodCustomerRoot(slug), `v${version}`);
}

export function lastKnownGoodIndexPath(): string {
  return join(lastKnownGoodRoot(), 'index.json');
}

// Marketplace `name` field per §6.7b (the slug-suffixed identifier registered
// with `claude plugin marketplace add`). Used as the namespace for `claude
// plugin install pm-os@<marketplace-name>` AND as the cache-path segment under
// `~/.claude/plugins/cache/<marketplace-name>/`.
export function marketplaceName(slug: string): string {
  return `mysecond-customer-${slug}`;
}

/**
 * Sentinel plugin name used by post-install Layer 1 probe.
 * `pm-os` is the single plugin shipped today. The probe verifies its
 * cache directory landed, but the install command's exit code is the
 * authoritative signal — probe failures log informationally and do not
 * abort install. (Historical: prior to single-plugin consolidation,
 * the sentinel was `pm-companion-sync` to verify the SECOND plugin
 * landed in a multi-plugin install.)
 */
export const SENTINEL_PLUGIN_NAME = 'pm-os';

/** Single plugin entry in a marketplace.json `plugins[]` array. */
export interface PluginEntry {
  name: string;
  source: string;
}

/**
 * Read PMO's tarball-internal `.claude-plugin/marketplace.json` and return
 * the `plugins[]` array, transformed so each `source` is relative to the
 * cli's outer marketplace dir layout.
 *
 * Background: PMO's tarball ships its own marketplace.json at
 * `<extractDir>/.claude-plugin/marketplace.json` declaring N sub-plugins
 * with sources like `./companion-sync` (relative to PMO root). The cli
 * extracts the tarball into `<marketplaceDir>/plugin/`, so an entry like
 * `{name: 'pm-companion-sync', source: './companion-sync'}` must be
 * rewritten to `{name: 'pm-companion-sync', source: './plugin/companion-sync'}`
 * so Claude Code can resolve it from the customer-marketplace's outer dir.
 *
 * Called from step-9 BEFORE atomic-rename of the tmp extract dir, so it
 * always reads PMO's source-of-truth — never the cli-generated overwrite.
 *
 * Throws if the manifest is missing or malformed: PMO repo invariant
 * guarantees it's always present in published tarballs (§6.7b spec).
 */
export function listMarketplacePluginsFromExtractDir(
  extractDir: string
): PluginEntry[] {
  const manifestPath = join(extractDir, '.claude-plugin', 'marketplace.json');
  const raw = readFileSync(manifestPath, 'utf-8');
  const parsed = JSON.parse(raw) as {
    plugins?: Array<{ name?: unknown; source?: unknown }>;
  };
  if (!Array.isArray(parsed.plugins) || parsed.plugins.length === 0) {
    throw new Error(
      `PMO tarball marketplace.json at ${manifestPath} has no plugins[] array. ` +
        `This indicates a malformed tarball — contact support@mysecond.ai.`
    );
  }
  return parsed.plugins
    .filter(
      (p): p is { name: string; source: string } =>
        typeof p?.name === 'string' && typeof p?.source === 'string',
    )
    .map((p) => ({
      name: p.name,
      // PMO's source like "./companion-sync" or "companion-sync" → cli layout
      // "./plugin/companion-sync". Strip leading "./" first to handle both forms.
      source: `./plugin/${p.source.replace(/^\.\//, '')}`,
    }));
}

/**
 * Plugin install spec for `claude plugin install` per §6.2 step 9 sub-step (f).
 * Format: `<plugin-name>@<marketplace-name>` per Claude Code docs.
 *
 * Workstream B Day 5+: was hardcoded `pm-os@...` — now takes plugin name
 * to support multi-plugin marketplace install (PMO restructured 2026-04-XX).
 * Legacy callers expecting single-plugin behavior pass SENTINEL_PLUGIN_NAME.
 */
export function pluginInstallSpec(slug: string, pluginName: string): string {
  return `${pluginName}@${marketplaceName(slug)}`;
}

/**
 * Empirically captured 2026-04-22 23:45 UTC (DV-2):
 * `~/.claude/plugins/cache/<marketplace-name>/<plugin-name>/<version>/.claude-plugin/plugin.json`.
 *
 * Workstream B Day 5+: parameterized on pluginName (was hardcoded `pm-os`)
 * for multi-plugin install probe.
 */
export function installedPluginManifestPath(
  slug: string,
  version: string,
  pluginName: string = SENTINEL_PLUGIN_NAME
): string {
  return join(
    homedir(),
    '.claude',
    'plugins',
    'cache',
    marketplaceName(slug),
    pluginName,
    version,
    '.claude-plugin',
    'plugin.json'
  );
}

/**
 * Same as above with wildcard version — used when caller doesn't know the exact
 * version (Layer 1 probe in §7.2). Returns the parent dir to glob.
 *
 * Workstream B Day 5+: parameterized on pluginName (was hardcoded `pm-os`).
 */
export function installedPluginCacheParent(
  slug: string,
  pluginName: string = SENTINEL_PLUGIN_NAME
): string {
  return join(homedir(), '.claude', 'plugins', 'cache', marketplaceName(slug), pluginName);
}

// Slug-format guard (RED-TEAM P0-2). The slug arrives from server responses
// and is interpolated into filesystem paths via marketplaceDir / cache paths.
// Without validation, a server-controlled slug like `../../etc` resolves to
// arbitrary directories — atomicRenameDir would `rmSync` them. Slug must
// match the same character class enforced server-side per EDD §1.4 invariant 1
// (`^[a-z][a-z0-9-]*[a-z0-9]$`). We're permissive on length (<=64) and allow
// uppercase + underscore for forward-compat; spec is the floor, not the ceiling.
const SLUG_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function validateSlug(slug: unknown): string {
  if (typeof slug !== 'string') {
    throw new Error(`Invalid customer slug: not a string (got ${typeof slug})`);
  }
  if (!SLUG_PATTERN.test(slug)) {
    // Don't echo the slug verbatim in case it contains shell metachars or
    // path-traversal sequences that could land in a downstream log message.
    // Length + pattern hint is enough for support to debug.
    throw new Error(
      `Invalid customer slug format (length=${slug.length}, expected ${SLUG_PATTERN.source}). Contact support@mysecond.ai.`
    );
  }
  return slug;
}

// Project-dir guard (§6.1) — refuse paths that would let us trample system or
// mysecond-managed dirs.
const FORBIDDEN_PROJECT_DIR_PREFIXES = [
  '/',
  '/etc',
  '/System',
  '/dev',
  '/proc',
];

export function isForbiddenProjectDir(absolutePath: string): boolean {
  if (FORBIDDEN_PROJECT_DIR_PREFIXES.includes(absolutePath)) return true;
  const home = homedir();
  // Reject project-dir == any of these home-dotfile / mysecond-managed roots.
  // Note: we DO allow project-dir to be a child of these (extremely unusual but
  // not our problem); we only block the literal root match.
  if (absolutePath === join(home, '.ssh')) return true;
  if (absolutePath === join(home, '.claude')) return true;
  if (absolutePath === mysecondHome()) return true;
  return false;
}
