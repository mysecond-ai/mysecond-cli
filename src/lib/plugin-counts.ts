// Count installed skills / sub-agents / workflows from the extracted plugin
// tree at `~/.mysecond/marketplaces/customer-{slug}/plugin/`.
//
// Used by step 13's post-install message as proof that the install populated
// real content. Counts are intentionally tolerant — missing dirs return 0,
// non-skill files (READMEs, .DS_Store) are ignored.
//
// Counting contract (tightened per Codex P2-7 — a stray dir/file must not
// inflate counts):
//   - a SKILL  = a subdirectory of `skills/` that contains a `SKILL.md` file.
//   - an AGENT = a `.md` FILE directly under `agents/`.
//   - a WORKFLOW = a `.md` FILE directly under `workflows/`.
// Anything else (loose files under `skills/`, subdirs under `agents/`, etc.)
// is not counted.
//
// Plugin layout — TWO shapes are supported:
//
//   (1) FLAT (current — what product-manager-os actually emits):
//       plugin/
//         .claude-plugin/plugin.json    (presence marks the FLAT plugin root)
//         skills/<skill-name>/SKILL.md  (counted as a skill)
//         agents/<agent-name>.md        (counted as a sub-agent)
//         workflows/<workflow>.md       (counted as a workflow)
//         commands/<wrapper>.md         (NOT counted — slash-command wrappers)
//
//   (2) MULTI-SUBPLUGIN (legacy — the abandoned 13-category experiment):
//       plugin/
//         <subplugin>/
//           .claude-plugin/plugin.json  (presence marks a real subplugin)
//           skills/ | agents/ | workflows/  (counted, summed across subplugins)
//
// Detection: if `plugin/.claude-plugin/plugin.json` exists, treat as FLAT and
// count directly under the root. Otherwise fall back to scanning subdirs for
// the multi-subplugin marker. Subdirs (or a root) without the marker contribute
// nothing — `context-templates/`, `work/`, READMEs etc. are skipped silently.
//
// If neither layout is detected, returns zeros. Returning zeros triggers the
// existing fallback string in `successBox` ("pm-os plugin registered with your
// PM skill library").

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface PluginCounts {
  skills: number;
  agents: number;
  workflows: number;
}

const EMPTY: PluginCounts = { skills: 0, agents: 0, workflows: 0 };

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isVisible(name: string): boolean {
  // Skip dotfiles (.DS_Store, .git, etc.).
  return !name.startsWith('.');
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function hasPluginManifest(dir: string): boolean {
  return existsSync(join(dir, '.claude-plugin', 'plugin.json'));
}

// Count skills under a `skills/` dir. A skill is a SUBDIRECTORY that contains a
// `SKILL.md` file — the Anthropic skill contract. A stray loose file or an
// empty/marker-less subdir (e.g. `.git`, a scratch dir) does NOT count. This is
// tighter than "any visible dir" (P2-7): a stray dir under `skills/` no longer
// inflates the count.
function countSkills(skillsDir: string): number {
  let count = 0;
  for (const name of safeReaddir(skillsDir)) {
    if (!isVisible(name)) continue;
    const skillDir = join(skillsDir, name);
    if (!isDir(skillDir)) continue;
    if (!existsSync(join(skillDir, 'SKILL.md'))) continue;
    count += 1;
  }
  return count;
}

// Count agents/workflows under their dir. Each is a single `.md` FILE
// (`agents/<name>.md`, `workflows/<name>.md`). Subdirectories are NOT counted —
// a stray dir under `agents/`/`workflows/` no longer inflates the count (P2-7).
function countMarkdownFiles(dir: string): number {
  let count = 0;
  for (const name of safeReaddir(dir)) {
    if (!isVisible(name)) continue;
    if (!name.toLowerCase().endsWith('.md')) continue;
    const full = join(dir, name);
    try {
      if (statSync(full).isFile()) count += 1;
    } catch {
      // unreadable entry; skip
    }
  }
  return count;
}

// Count skills/agents/workflows directly under a single plugin root.
function countOnePlugin(pluginRoot: string): PluginCounts {
  return {
    skills: countSkills(join(pluginRoot, 'skills')),
    agents: countMarkdownFiles(join(pluginRoot, 'agents')),
    workflows: countMarkdownFiles(join(pluginRoot, 'workflows')),
  };
}

export function countPluginContents(pluginDir: string): PluginCounts {
  if (!isDir(pluginDir)) return { ...EMPTY };

  // FLAT layout: the plugin manifest sits at the root. product-manager-os
  // ships a single `pm-os` plugin with `source: "./"`, so the extracted tree's
  // root IS the plugin root — skills/agents/workflows live directly under it.
  if (hasPluginManifest(pluginDir)) {
    return countOnePlugin(pluginDir);
  }

  // MULTI-SUBPLUGIN layout (legacy): sum every subdir that carries its own
  // `.claude-plugin/plugin.json` marker. Subdirs without the marker
  // (context-templates/, work/) are skipped silently.
  const totals: PluginCounts = { skills: 0, agents: 0, workflows: 0 };
  let foundAnySubplugin = false;

  for (const name of safeReaddir(pluginDir)) {
    if (!isVisible(name)) continue;
    const subDir = join(pluginDir, name);
    if (!isDir(subDir)) continue;
    if (!hasPluginManifest(subDir)) continue;

    foundAnySubplugin = true;
    const sub = countOnePlugin(subDir);
    totals.skills += sub.skills;
    totals.agents += sub.agents;
    totals.workflows += sub.workflows;
  }

  if (!foundAnySubplugin) return { ...EMPTY };
  return totals;
}
