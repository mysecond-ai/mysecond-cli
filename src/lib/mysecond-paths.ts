// `~/.mysecond/...` path helpers — the mySecond-managed dir per Decision 0-C.
// Cross-platform via `os.homedir()` + `path.join()` (guardrail #4 — never `/` or `~`).

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

// Plugin install spec for `claude plugin install` per §6.2 step 9 sub-step (f).
// Format: `pm-os@<marketplace-name>` per Claude Code docs.
export function pluginInstallSpec(slug: string): string {
  return `pm-os@${marketplaceName(slug)}`;
}

// Empirically captured 2026-04-22 23:45 UTC (DV-2):
// `~/.claude/plugins/cache/<marketplace-name>/<plugin-name>/<version>/.claude-plugin/plugin.json`.
export function installedPluginManifestPath(slug: string, version: string): string {
  return join(
    homedir(),
    '.claude',
    'plugins',
    'cache',
    marketplaceName(slug),
    'pm-os',
    version,
    '.claude-plugin',
    'plugin.json'
  );
}

// Same as above with wildcard version — used when caller doesn't know the exact
// version (Layer 1 probe in §7.2). Returns the parent dir to glob.
export function installedPluginCacheParent(slug: string): string {
  return join(homedir(), '.claude', 'plugins', 'cache', marketplaceName(slug), 'pm-os');
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
