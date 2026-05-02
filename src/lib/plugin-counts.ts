// Count installed skills / sub-agents / workflows from the extracted plugin
// tree at `~/.mysecond/marketplaces/customer-{slug}/plugin/`.
//
// Used by step 13's post-install message as proof that the install populated
// real content. Counts are intentionally tolerant — missing dirs return 0,
// non-skill files (READMEs, .DS_Store) are ignored.
//
// Plugin layout (multi-subplugin — what product-manager-os actually emits):
//   plugin/
//     <subplugin>/
//       .claude-plugin/plugin.json    (presence marks a real subplugin)
//       skills/<skill-name>/SKILL.md  (counted as a skill)
//       agents/<agent-name>.md        (counted as a sub-agent)
//       workflows/<workflow>.md       (counted as a workflow — workflows-pack)
//       commands/<wrapper>.md         (NOT counted — slash-command wrappers
//                                     around skills, 1:1 with the skills/ dir)
//
// Subdirs without `.claude-plugin/plugin.json` (e.g. `context-templates/`,
// `work/`) are skipped silently so they neither contribute nor break counting.
//
// If no subplugins are detected, returns zeros — there is no flat-layout
// fallback. The cli only ever installs product-manager-os, which is always
// multi-subplugin. Returning zeros triggers the existing fallback string in
// `successBox` ("pm-os plugin registered with your PM skill library").

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

function countDirEntries(dir: string): number {
  let count = 0;
  for (const name of safeReaddir(dir)) {
    if (!isVisible(name)) continue;
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        count += 1;
      } else if (st.isFile() && name.toLowerCase().endsWith('.md')) {
        // Allow flat-file layouts (agents/foo.md, workflows/foo.md) too.
        count += 1;
      }
    } catch {
      // unreadable entry; skip
    }
  }
  return count;
}

export function countPluginContents(pluginDir: string): PluginCounts {
  if (!isDir(pluginDir)) return { ...EMPTY };

  const totals: PluginCounts = { skills: 0, agents: 0, workflows: 0 };
  let foundAnySubplugin = false;

  for (const name of safeReaddir(pluginDir)) {
    if (!isVisible(name)) continue;
    const subDir = join(pluginDir, name);
    if (!isDir(subDir)) continue;
    if (!existsSync(join(subDir, '.claude-plugin', 'plugin.json'))) continue;

    foundAnySubplugin = true;
    totals.skills += countDirEntries(join(subDir, 'skills'));
    totals.agents += countDirEntries(join(subDir, 'agents'));
    totals.workflows += countDirEntries(join(subDir, 'workflows'));
  }

  if (!foundAnySubplugin) return { ...EMPTY };
  return totals;
}
