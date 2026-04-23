// Post-install plugin-load detection per EDD §7.2 (decision 0041).
// PR 4c implements only Layer 1 (filesystem probe). Layers 2 (sentinel) and 3
// (soft-warn fallback) land in PR 4d (§7.3 admin-restricted disambiguation).
//
// Layer 1 checks the empirically-verified cache path captured in DV-2 (2026-04-22):
// `~/.claude/plugins/cache/<marketplace-name>/pm-os/<version>/.claude-plugin/plugin.json`.
// `<version>` is wildcard-globbed when caller doesn't know the exact version.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { installedPluginCacheParent, installedPluginManifestPath } from './mysecond-paths.js';

export type LayerOneResult =
  | { found: true; version: string; manifestPath: string }
  | { found: false };

// Probe the canonical Layer 1 cache path. If `version` is provided, check the
// exact path; otherwise glob under the parent dir for any version subdir
// containing `.claude-plugin/plugin.json`.
export function probeLayerOne(
  slug: string,
  version: string | null = null
): LayerOneResult {
  if (version !== null) {
    const path = installedPluginManifestPath(slug, version);
    if (existsSync(path)) {
      return { found: true, version, manifestPath: path };
    }
    return { found: false };
  }

  // Wildcard: list version subdirs under `~/.claude/plugins/cache/<marketplace>/pm-os/`.
  const parent = installedPluginCacheParent(slug);
  if (!existsSync(parent)) return { found: false };

  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return { found: false };
  }

  // Sort descending so newest version wins on multi-version cache (rare but
  // possible if Claude Code keeps prior versions during an upgrade).
  const sorted = [...entries].sort().reverse();
  for (const entry of sorted) {
    const versionDir = join(parent, entry);
    let isDir = false;
    try {
      isDir = statSync(versionDir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const manifestPath = join(versionDir, '.claude-plugin', 'plugin.json');
    if (existsSync(manifestPath)) {
      return { found: true, version: entry, manifestPath };
    }
  }
  return { found: false };
}
