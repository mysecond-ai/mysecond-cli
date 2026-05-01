// Count installed skills / sub-agents / workflows from the extracted plugin
// tree at `~/.mysecond/marketplaces/customer-{slug}/plugin/`.
//
// Used by step 13's post-install message as proof that the install populated
// real content. Counts are intentionally tolerant — missing dirs return 0,
// non-skill files (READMEs, .DS_Store) are ignored.
//
// Plugin layout convention (Claude Code plugins):
//   plugin/
//     skills/<skill-name>/SKILL.md
//     agents/<agent-name>.md   OR  agents/<agent-name>/...
//     commands/<command-name>.md   (we treat commands == workflows for the
//                                   post-install message; this is the
//                                   customer-facing label, see EDD §6.8)

import { readdirSync, statSync } from 'node:fs';
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
        // Allow flat-file layouts (agents/foo.md, commands/foo.md) too.
        count += 1;
      }
    } catch {
      // unreadable entry; skip
    }
  }
  return count;
}

export function countPluginContents(pluginDir: string): PluginCounts {
  try {
    const st = statSync(pluginDir);
    if (!st.isDirectory()) return { ...EMPTY };
  } catch {
    return { ...EMPTY };
  }
  return {
    skills: countDirEntries(join(pluginDir, 'skills')),
    agents: countDirEntries(join(pluginDir, 'agents')),
    workflows: countDirEntries(join(pluginDir, 'commands')),
  };
}
