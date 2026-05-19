import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ARTIFACT_DIRS,
  buildAuthoredBy,
  classifyArtifactType,
  isContextFile,
  isCustomsArtifact,
  scanArtifacts,
  scanContextFiles,
} from '../../src/lib/payload.js';

describe('classifyArtifactType', () => {
  it('classifies known artifact dirs', () => {
    expect(classifyArtifactType('specs/outputs/foo.md')).toBe('prd');
    expect(classifyArtifactType('strategy/outputs/bar.md')).toBe('strategy');
    expect(classifyArtifactType('discovery/outputs/baz.md')).toBe('research');
    expect(classifyArtifactType('launch/outputs/x.md')).toBe('launch');
    expect(classifyArtifactType('analytics/outputs/y.md')).toBe('analytics');
    expect(classifyArtifactType('workflows/foo/outputs/z.md')).toBe('other');
  });

  it('returns null for paths outside artifact dirs', () => {
    expect(classifyArtifactType('context/company.md')).toBeNull();
    expect(classifyArtifactType('README.md')).toBeNull();
    expect(classifyArtifactType('.claude/skills/foo/SKILL.md')).toBeNull();
  });

  it('rejects unsafe paths', () => {
    expect(classifyArtifactType('/abs/path.md')).toBeNull();
    expect(classifyArtifactType('../escape/specs/outputs/x.md')).toBeNull();
  });

  it('skips test outputs', () => {
    expect(classifyArtifactType('specs/outputs/tests/x.md')).toBeNull();
  });

  // Follow-up #8 — case-insensitive prefix match.
  it('classifies case-variant artifact prefixes on case-insensitive filesystems', () => {
    expect(classifyArtifactType('Specs/Outputs/foo.md')).toBe('prd');
    expect(classifyArtifactType('STRATEGY/OUTPUTS/bar.md')).toBe('strategy');
    expect(classifyArtifactType('Workflows/Foo/Outputs/z.md')).toBe('other');
  });
});

describe('ARTIFACT_DIRS', () => {
  it('covers the canonical work/* output locations + legacy unprefixed', () => {
    // Canonical: every skill writes to work/<area>/outputs/...
    // Legacy: pre-work/ tree convention, kept as back-compat synonyms.
    expect(ARTIFACT_DIRS.map((d) => d.relativeDir).sort()).toEqual([
      'analytics/outputs',
      'discovery/outputs',
      'launch/outputs',
      'specs/outputs',
      'strategy/outputs',
      'work/discovery/outputs',
      'work/launches/outputs',
      'work/specs/outputs',
      'work/strategy/outputs',
    ]);
  });

  it('classifies a real skill output path (work/specs/outputs/...) as prd', () => {
    // Regression: 2026-05-02 customer E2E — /prd-generator wrote to
    // work/specs/outputs/2026-05-02-1622/prd-dashboard.md, but the cli's
    // PostToolUse handler returned null because ARTIFACT_DIRS didn't include
    // the work/ prefix. Lock that path.
    expect(classifyArtifactType('work/specs/outputs/2026-05-02-1622/prd-dashboard.md')).toBe('prd');
    expect(classifyArtifactType('work/strategy/outputs/2026-05-01/competitive-profile.md')).toBe('strategy');
    expect(classifyArtifactType('work/discovery/outputs/2026-05-01/research.md')).toBe('research');
    expect(classifyArtifactType('work/launches/outputs/2026-05-01/launch-plan.md')).toBe('launch');
  });

  // When Claude writes to a non-canonical work area on its own (e.g. invents
  // `work/product/` for release notes, or `work/retros/` for a retrospective),
  // the file MUST still sync. The classifier returns 'other' for any
  // `work/<area>/outputs/` path not in the canonical set, so the file is
  // shipped to the server rather than silently dropped on the floor.
  it('classifies non-canonical work areas as other (catch-all for Claude-invented folders)', () => {
    expect(classifyArtifactType('work/product/outputs/2026-05-02/release-notes.md')).toBe('other');
    expect(classifyArtifactType('work/retros/outputs/2026-05-02/q1-retro.md')).toBe('other');
    expect(classifyArtifactType('work/anything/outputs/foo.md')).toBe('other');
    // Case-insensitive parity with canonical paths.
    expect(classifyArtifactType('Work/Product/Outputs/foo.md')).toBe('other');
  });

  it('rejects non-output paths under work/ (no silent .md sweep)', () => {
    // Only `work/<area>/outputs/...md` syncs. Inputs, README files, and any
    // other `work/<area>/` content stays local.
    expect(classifyArtifactType('work/product/inputs/notes.md')).toBeNull();
    expect(classifyArtifactType('work/product/README.md')).toBeNull();
    expect(classifyArtifactType('work/specs/inputs/draft.md')).toBeNull();
    expect(classifyArtifactType('work/notes.md')).toBeNull();
  });

  it('rejects non-.md files even under outputs/', () => {
    expect(classifyArtifactType('work/product/outputs/data.json')).toBeNull();
    expect(classifyArtifactType('work/product/outputs/image.png')).toBeNull();
  });
});

describe('isContextFile', () => {
  it('accepts top-level .md under context/', () => {
    expect(isContextFile('context/company.md')).toBe(true);
    expect(isContextFile('context/product.md')).toBe(true);
  });

  it('accepts nested .md under context/', () => {
    expect(isContextFile('context/personas/buyer.md')).toBe(true);
    expect(isContextFile('context/sub/deep/file.md')).toBe(true);
  });

  it('rejects non-context paths', () => {
    expect(isContextFile('CLAUDE.md')).toBe(false);
    expect(isContextFile('NOT_CONTEXT.md')).toBe(false);
    expect(isContextFile('specs/outputs/foo.md')).toBe(false);
    expect(isContextFile('contextual/foo.md')).toBe(false);
  });

  it('rejects non-.md files under context/', () => {
    expect(isContextFile('context/binary.png')).toBe(false);
    expect(isContextFile('context/data.json')).toBe(false);
    expect(isContextFile('context/README')).toBe(false);
  });

  it('rejects unsafe paths', () => {
    expect(isContextFile('/abs/context/foo.md')).toBe(false);
    expect(isContextFile('../escape/context/foo.md')).toBe(false);
    expect(isContextFile('context/../etc/passwd')).toBe(false);
  });

  // Follow-up #8 — case-insensitive filesystems (macOS APFS, Windows NTFS
  // default) resolve `Context/foo.md` and `context/foo.md` to the same disk
  // file. A skill that emits the wrong case must not silently drop.
  it('accepts case-variant context prefix on case-insensitive filesystems', () => {
    expect(isContextFile('Context/company.md')).toBe(true);
    expect(isContextFile('CONTEXT/personas.md')).toBe(true);
    expect(isContextFile('CoNtExT/goals.md')).toBe(true);
  });

  it('accepts case-variant .md suffix', () => {
    expect(isContextFile('context/company.MD')).toBe(true);
    expect(isContextFile('context/product.Md')).toBe(true);
  });

  // PMO-4: index.md is auto-generated metadata, not a real context file. Must
  // not sync to context_files even though it lives under context/.
  it('rejects auto-generated index.md', () => {
    expect(isContextFile('context/index.md')).toBe(false);
    expect(isContextFile('context/Index.md')).toBe(false);
    expect(isContextFile('context/INDEX.MD')).toBe(false);
  });

  it('rejects index.md in nested context paths', () => {
    expect(isContextFile('context/personas/index.md')).toBe(false);
    expect(isContextFile('context/sub/deep/index.md')).toBe(false);
  });

  it('still accepts other files alongside excluded index.md', () => {
    expect(isContextFile('context/company.md')).toBe(true);
    expect(isContextFile('context/personas/buyer.md')).toBe(true);
  });
});

describe('scanContextFiles', () => {
  function tmpProject(): string {
    return mkdtempSync(join(tmpdir(), 'mysecond-context-scan-'));
  }

  it('returns [] when context/ is missing', () => {
    expect(scanContextFiles(tmpProject())).toEqual([]);
  });

  it('walks nested directories', () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context/personas'), { recursive: true });
    writeFileSync(join(root, 'context/company.md'), '# Company');
    writeFileSync(join(root, 'context/personas/buyer.md'), '# Buyer');

    const files = scanContextFiles(root);
    const paths = files.map((f) => f.file_path).sort();
    expect(paths).toEqual(['context/company.md', 'context/personas/buyer.md']);
    for (const f of files) {
      expect(f.current_hash).toMatch(/^[0-9a-f]{12}$/);
      expect(f.content.length).toBeGreaterThan(0);
    }
  });

  it('skips empty files', () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    writeFileSync(join(root, 'context/empty.md'), '');
    writeFileSync(join(root, 'context/non-empty.md'), 'x');

    const paths = scanContextFiles(root).map((f) => f.file_path);
    expect(paths).toEqual(['context/non-empty.md']);
  });

  it('skips non-.md files', () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    writeFileSync(join(root, 'context/data.json'), '{}');
    writeFileSync(join(root, 'context/binary.png'), 'fake');
    writeFileSync(join(root, 'context/keeper.md'), 'k');

    const paths = scanContextFiles(root).map((f) => f.file_path);
    expect(paths).toEqual(['context/keeper.md']);
  });

  it('skips files larger than 50KB', () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    writeFileSync(join(root, 'context/huge.md'), 'x'.repeat(50 * 1024 + 1));
    writeFileSync(join(root, 'context/small.md'), 'tiny');

    const paths = scanContextFiles(root).map((f) => f.file_path);
    expect(paths).toEqual(['context/small.md']);
  });

  it('hashes deterministically — same content always produces same hash', () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    writeFileSync(join(root, 'context/a.md'), 'identical content');
    writeFileSync(join(root, 'context/b.md'), 'identical content');

    const files = scanContextFiles(root);
    const hashes = files.map((f) => f.current_hash);
    expect(hashes[0]).toBe(hashes[1]);
  });

  it('skips dotfiles (e.g. .DS_Store, .notes.md) and dotdirs', () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context/.hidden-dir'), { recursive: true });
    writeFileSync(join(root, 'context/.notes.md'), 'private');
    writeFileSync(join(root, 'context/.hidden-dir/leak.md'), 'leak');
    writeFileSync(join(root, 'context/visible.md'), 'public');

    const paths = scanContextFiles(root).map((f) => f.file_path);
    expect(paths).toEqual(['context/visible.md']);
  });

  it('preserves frontmatter byte-identical', () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    const original = '---\ntitle: Test\n---\n\n# Body\n';
    writeFileSync(join(root, 'context/fm.md'), original);

    const files = scanContextFiles(root);
    expect(files[0]?.content).toBe(original);
  });
});

describe('scanArtifacts', () => {
  function tmpProject(): string {
    return mkdtempSync(join(tmpdir(), 'mysecond-artifact-scan-'));
  }

  it('returns [] when no work/ or canonical legacy dirs exist', () => {
    expect(scanArtifacts(tmpProject())).toEqual([]);
  });

  it('walks canonical work/ activity-tree areas with their typed artifact_type', () => {
    const root = tmpProject();
    mkdirSync(join(root, 'work/specs/outputs/2026-05-02'), { recursive: true });
    mkdirSync(join(root, 'work/strategy/outputs'), { recursive: true });
    writeFileSync(join(root, 'work/specs/outputs/2026-05-02/prd.md'), '# PRD');
    writeFileSync(join(root, 'work/strategy/outputs/comp.md'), '# Comp');

    const found = scanArtifacts(root);
    const byPath = Object.fromEntries(found.map((a) => [a.file_path, a.artifact_type]));
    expect(byPath['work/specs/outputs/2026-05-02/prd.md']).toBe('prd');
    expect(byPath['work/strategy/outputs/comp.md']).toBe('strategy');
  });

  // CRITICAL: when Claude invents a non-canonical work area on its own (e.g.
  // work/product/, work/retros/), scanArtifacts must DISCOVER and walk it.
  // Without this, SessionStart's full sweep silently drops every file Claude
  // wrote to a non-canonical area between sessions — exactly the symptom Ron
  // hit when /prd-generator routed an output to work/product/.
  it('discovers and syncs non-canonical work areas (work/product/outputs, etc.)', () => {
    const root = tmpProject();
    mkdirSync(join(root, 'work/product/outputs/2026-05-02'), { recursive: true });
    mkdirSync(join(root, 'work/retros/outputs'), { recursive: true });
    writeFileSync(join(root, 'work/product/outputs/2026-05-02/release-notes.md'), '# v1.4');
    writeFileSync(join(root, 'work/retros/outputs/q1.md'), '# Q1 retro');

    const found = scanArtifacts(root);
    const byPath = Object.fromEntries(found.map((a) => [a.file_path, a.artifact_type]));
    expect(byPath['work/product/outputs/2026-05-02/release-notes.md']).toBe('other');
    expect(byPath['work/retros/outputs/q1.md']).toBe('other');
  });

  it('does not walk non-outputs/ subdirectories of non-canonical work areas', () => {
    const root = tmpProject();
    mkdirSync(join(root, 'work/product/inputs'), { recursive: true });
    writeFileSync(join(root, 'work/product/inputs/notes.md'), '# Local notes');
    writeFileSync(join(root, 'work/product/README.md'), '# README');

    const found = scanArtifacts(root);
    expect(found).toEqual([]);
  });

  it('does not double-walk a canonical area when its dir exists on disk', () => {
    const root = tmpProject();
    mkdirSync(join(root, 'work/specs/outputs'), { recursive: true });
    writeFileSync(join(root, 'work/specs/outputs/prd.md'), '# PRD');

    const found = scanArtifacts(root);
    expect(found).toHaveLength(1);
    expect(found[0]?.file_path).toBe('work/specs/outputs/prd.md');
    expect(found[0]?.artifact_type).toBe('prd'); // canonical type, not 'other'
  });

  it('skips dotdirs at the work/ level', () => {
    const root = tmpProject();
    mkdirSync(join(root, 'work/.hidden/outputs'), { recursive: true });
    writeFileSync(join(root, 'work/.hidden/outputs/secret.md'), 'leak');

    expect(scanArtifacts(root)).toEqual([]);
  });
});

describe('isCustomsArtifact', () => {
  it('matches customer skill paths under .claude/skills/<slug>/', () => {
    expect(isCustomsArtifact('.claude/skills/prd-generator/SKILL.md')).toBe(true);
    expect(isCustomsArtifact('.claude/skills/my-skill/example.md')).toBe(true);
    expect(isCustomsArtifact('.CLAUDE/Skills/Mixed-Case/SKILL.md')).toBe(true); // case-insensitive
  });

  it('matches sub-agent paths flat under .claude/agents/', () => {
    expect(isCustomsArtifact('.claude/agents/reviewer.md')).toBe(true);
    expect(isCustomsArtifact('.claude/agents/cto-tech-lead.md')).toBe(true);
  });

  it('matches workflow files nested under .claude/workflows/<slug>/', () => {
    expect(isCustomsArtifact('.claude/workflows/launch-checklist/step-1.md')).toBe(true);
    expect(isCustomsArtifact('.claude/workflows/onboarding/intro.md')).toBe(true);
  });

  it('rejects bare files under .claude/ root', () => {
    expect(isCustomsArtifact('.claude/SETTINGS.md')).toBe(false);
    expect(isCustomsArtifact('.claude/skills/SKILL.md')).toBe(false); // missing slug dir
  });

  it('rejects nested-too-deep skill paths', () => {
    // Spec is .claude/skills/<slug>/<single-segment>.md — deeper nesting is
    // not a recognized customs artifact (could be tests/, examples/foo/bar/).
    expect(isCustomsArtifact('.claude/skills/foo/bar/baz.md')).toBe(false);
  });

  it('rejects non-.md files', () => {
    expect(isCustomsArtifact('.claude/skills/foo/SKILL.txt')).toBe(false);
    expect(isCustomsArtifact('.claude/agents/reviewer.json')).toBe(false);
  });

  it('rejects path-traversal and absolute paths', () => {
    expect(isCustomsArtifact('/abs/.claude/skills/foo/SKILL.md')).toBe(false);
    expect(isCustomsArtifact('../.claude/skills/foo/SKILL.md')).toBe(false);
  });

  it('rejects paths outside the .claude/ tree', () => {
    expect(isCustomsArtifact('context/skills/foo/SKILL.md')).toBe(false);
    expect(isCustomsArtifact('work/skills/foo/SKILL.md')).toBe(false);
    expect(isCustomsArtifact('skills/foo/SKILL.md')).toBe(false);
  });
});

describe('buildAuthoredBy', () => {
  const savedSessionId = process.env.CLAUDE_SESSION_ID;
  const savedModel = process.env.CLAUDE_MODEL;

  afterEach(() => {
    if (savedSessionId === undefined) delete process.env.CLAUDE_SESSION_ID;
    else process.env.CLAUDE_SESSION_ID = savedSessionId;
    if (savedModel === undefined) delete process.env.CLAUDE_MODEL;
    else process.env.CLAUDE_MODEL = savedModel;
  });

  it('uses CLAUDE_SESSION_ID as identity when set (preferred path)', () => {
    process.env.CLAUDE_SESSION_ID = 'sess_abc123';
    delete process.env.CLAUDE_MODEL;
    const result = buildAuthoredBy();
    expect(result).toEqual({
      kind: 'ai',
      source: 'claude-code',
      identity: 'sess_abc123',
    });
  });

  it('falls back to `${model}:${timestamp}` when CLAUDE_SESSION_ID is unset', () => {
    delete process.env.CLAUDE_SESSION_ID;
    process.env.CLAUDE_MODEL = 'claude-sonnet-4-7';
    const result = buildAuthoredBy();
    expect(result.kind).toBe('ai');
    expect(result.source).toBe('claude-code');
    // identity is `${model}:${ISO timestamp}` — never bare model name.
    expect(result.identity).toMatch(/^claude-sonnet-4-7:\d{4}-\d{2}-\d{2}T/);
  });

  it('falls back to `claude-code:${timestamp}` when BOTH env vars missing', () => {
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.CLAUDE_MODEL;
    const result = buildAuthoredBy();
    expect(result.identity).toMatch(/^claude-code:\d{4}-\d{2}-\d{2}T/);
    // Sanity: identity is never just the model name (CAIO cardinality rule).
    expect(result.identity).not.toBe('claude-code');
  });

  it('treats empty-string CLAUDE_SESSION_ID as unset (falls back)', () => {
    process.env.CLAUDE_SESSION_ID = '';
    process.env.CLAUDE_MODEL = 'claude-opus-4';
    const result = buildAuthoredBy();
    expect(result.identity).toMatch(/^claude-opus-4:/);
  });
});
