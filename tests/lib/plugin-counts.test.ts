import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { countPluginContents } from '../../src/lib/plugin-counts.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'mysecond-plugin-counts-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// Make a subplugin dir with .claude-plugin/plugin.json marker.
function makeSubplugin(root: string, name: string): string {
  const sub = join(root, name);
  mkdirSync(join(sub, '.claude-plugin'), { recursive: true });
  writeFileSync(join(sub, '.claude-plugin', 'plugin.json'), '{}');
  return sub;
}

// Mark a dir as a FLAT plugin root by dropping .claude-plugin/plugin.json into it.
function makeFlatPluginRoot(root: string): void {
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), '{}');
}

// Add N skill subdirs (each with a SKILL.md file) under <sub>/skills/.
function addSkills(sub: string, count: number): void {
  for (let i = 0; i < count; i++) {
    const skill = join(sub, 'skills', `skill-${i}`);
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '# skill');
  }
}

// Add N agent .md files under <sub>/agents/.
function addAgents(sub: string, count: number): void {
  mkdirSync(join(sub, 'agents'), { recursive: true });
  for (let i = 0; i < count; i++) {
    writeFileSync(join(sub, 'agents', `agent-${i}.md`), '# agent');
  }
}

// Add N workflow .md files under <sub>/workflows/.
function addWorkflows(sub: string, count: number): void {
  mkdirSync(join(sub, 'workflows'), { recursive: true });
  for (let i = 0; i < count; i++) {
    writeFileSync(join(sub, 'workflows', `wf-${i}.md`), '# wf');
  }
}

// Add N command wrappers under <sub>/commands/. These should NOT be counted
// as workflows — they're slash-command wrappers around skills (1:1).
function addCommands(sub: string, count: number): void {
  mkdirSync(join(sub, 'commands'), { recursive: true });
  for (let i = 0; i < count; i++) {
    writeFileSync(join(sub, 'commands', `cmd-${i}.md`), '# cmd');
  }
}

// Build the verified production layout: 79 skills + 12 agents + 7 workflows.
function buildProductionLayout(root: string): void {
  const skillSubplugins: Array<[string, number]> = [
    ['communication', 9],
    ['competitive', 6],
    ['data', 7],
    ['discovery', 13],
    ['launch', 3],
    ['operations', 6],
    ['planning', 7],
    ['specs', 9],
    ['strategy', 19],
  ];
  for (const [name, n] of skillSubplugins) {
    const sub = makeSubplugin(root, name);
    addSkills(sub, n);
    // Each skill subplugin also has commands/ wrappers (1:1) — must NOT be
    // counted as workflows. Add them so the test catches a regression that
    // would re-count them.
    addCommands(sub, n);
  }

  // personas/ subplugin: agents only.
  addAgents(makeSubplugin(root, 'personas'), 12);

  // workflows-pack/ subplugin: workflows only.
  addWorkflows(makeSubplugin(root, 'workflows-pack'), 7);

  // companion-sync/ subplugin: hooks only, no countable content.
  const sync = makeSubplugin(root, 'companion-sync');
  mkdirSync(join(sync, 'hooks'), { recursive: true });
  writeFileSync(join(sync, 'hooks', 'pre-tool-use.sh'), '#!/bin/sh');
}

describe('countPluginContents', () => {
  it('multi-subplugin happy path returns 79 skills, 12 agents, 7 workflows', () => {
    buildProductionLayout(workDir);
    expect(countPluginContents(workDir)).toEqual({
      skills: 79,
      agents: 12,
      workflows: 7,
    });
  });

  it('FLAT layout (.claude-plugin/plugin.json at root) counts skills/agents/workflows directly', () => {
    // This is the layout product-manager-os actually emits: a single `pm-os`
    // plugin with source "./" — skills/agents/workflows live under the root.
    makeFlatPluginRoot(workDir);
    addSkills(workDir, 84);
    addAgents(workDir, 6);
    addWorkflows(workDir, 7);
    // commands/ wrappers must NOT be counted as workflows.
    addCommands(workDir, 84);

    expect(countPluginContents(workDir)).toEqual({
      skills: 84,
      agents: 6,
      workflows: 7,
    });
  });

  it('FLAT layout with missing dirs returns zeros for the missing kinds', () => {
    // Plugin root marker present, but no agents/ or workflows/ dir.
    makeFlatPluginRoot(workDir);
    addSkills(workDir, 12);

    expect(countPluginContents(workDir)).toEqual({
      skills: 12,
      agents: 0,
      workflows: 0,
    });
  });

  it('no plugin manifest anywhere (no flat root marker, no subplugin marker) returns zeros', () => {
    // A bare flat layout WITHOUT the .claude-plugin/plugin.json marker is not a
    // recognizable plugin tree — no marker means we cannot trust the shape.
    mkdirSync(join(workDir, 'skills', 'a'), { recursive: true });
    writeFileSync(join(workDir, 'skills', 'a', 'SKILL.md'), '# s');
    mkdirSync(join(workDir, 'agents'), { recursive: true });
    writeFileSync(join(workDir, 'agents', 'a.md'), '# a');
    mkdirSync(join(workDir, 'commands'), { recursive: true });
    writeFileSync(join(workDir, 'commands', 'c.md'), '# c');

    expect(countPluginContents(workDir)).toEqual({
      skills: 0,
      agents: 0,
      workflows: 0,
    });
  });

  it('missing pluginDir returns zeros', () => {
    expect(countPluginContents(join(workDir, 'does-not-exist'))).toEqual({
      skills: 0,
      agents: 0,
      workflows: 0,
    });
  });

  it('subdirs without .claude-plugin/plugin.json are skipped without subtracting from totals', () => {
    buildProductionLayout(workDir);

    // Add the real-layout decoys: context-templates/ has stray .md files,
    // work/ has subdirs. Neither has plugin.json — both must be ignored.
    const ct = join(workDir, 'context-templates');
    mkdirSync(ct, { recursive: true });
    writeFileSync(join(ct, 'company.md'), '# stray');
    writeFileSync(join(ct, 'product.md'), '# stray');

    const work = join(workDir, 'work');
    mkdirSync(join(work, 'discovery'), { recursive: true });
    mkdirSync(join(work, 'specs'), { recursive: true });

    // Even with these decoys, totals must be unchanged.
    expect(countPluginContents(workDir)).toEqual({
      skills: 79,
      agents: 12,
      workflows: 7,
    });
  });

  it('subplugin commands/ dirs are NOT counted as workflows (regression guard)', () => {
    // One subplugin with both commands/ (10) and workflows/ (3). Workflows
    // count = 3, NOT 13.
    const sub = makeSubplugin(workDir, 'mixed');
    addCommands(sub, 10);
    addWorkflows(sub, 3);

    expect(countPluginContents(workDir).workflows).toBe(3);
  });
});
