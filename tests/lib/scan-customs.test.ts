// scanCustoms — the SessionStart/--push customs sweep scanner. Walks
// .claude/{agents,skills,workflows}, emits a ContextFilePayload per file that
// isCustomsArtifact accepts (agents flat, skills/workflows nested), with the
// same size guard + dotfile skip as scanContextFiles.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { scanCustoms, CONTEXT_PER_FILE_LIMIT } from '../../src/lib/payload.js';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'mysecond-customs-scan-'));
}

describe('scanCustoms', () => {
  it('returns [] when no .claude customs dirs exist', () => {
    expect(scanCustoms(tmpProject())).toEqual([]);
  });

  it('picks up flat agents and nested skills/workflows', () => {
    const root = tmpProject();
    mkdirSync(join(root, '.claude/agents'), { recursive: true });
    mkdirSync(join(root, '.claude/skills/prd-gen'), { recursive: true });
    mkdirSync(join(root, '.claude/workflows/launch'), { recursive: true });
    writeFileSync(join(root, '.claude/agents/cro.md'), '# CRO');
    writeFileSync(join(root, '.claude/skills/prd-gen/SKILL.md'), '# PRD');
    writeFileSync(join(root, '.claude/workflows/launch/workflow.md'), '# Launch');

    const paths = scanCustoms(root).map((f) => f.file_path).sort();
    expect(paths).toEqual([
      '.claude/agents/cro.md',
      '.claude/skills/prd-gen/SKILL.md',
      '.claude/workflows/launch/workflow.md',
    ]);
  });

  it('enforces the customs shape — a bare .md directly under skills/ is rejected', () => {
    const root = tmpProject();
    mkdirSync(join(root, '.claude/skills'), { recursive: true });
    // isCustomsArtifact requires .claude/skills/<slug>/<file>.md — a file
    // directly under skills/ has no slug dir and must NOT sync.
    writeFileSync(join(root, '.claude/skills/loose.md'), 'x');
    expect(scanCustoms(root)).toEqual([]);
  });

  it('skips empty files and anything over the per-file size cap', () => {
    const root = tmpProject();
    mkdirSync(join(root, '.claude/agents'), { recursive: true });
    writeFileSync(join(root, '.claude/agents/empty.md'), '');
    writeFileSync(join(root, '.claude/agents/huge.md'), 'x'.repeat(CONTEXT_PER_FILE_LIMIT + 1));
    writeFileSync(join(root, '.claude/agents/ok.md'), 'tiny');

    const paths = scanCustoms(root).map((f) => f.file_path);
    expect(paths).toEqual(['.claude/agents/ok.md']);
  });

  it('stamps current_hash and authored_by provenance', () => {
    const root = tmpProject();
    mkdirSync(join(root, '.claude/agents'), { recursive: true });
    writeFileSync(join(root, '.claude/agents/cro.md'), '# CRO');

    const [file] = scanCustoms(root);
    expect(file?.current_hash).toMatch(/^[0-9a-f]{12}$/);
    expect(file?.authored_by?.kind).toBe('ai');
    expect(file?.authored_by?.source).toBe('claude-code');
  });
});
