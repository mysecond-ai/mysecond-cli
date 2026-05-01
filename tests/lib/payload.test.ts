import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ARTIFACT_DIRS,
  classifyArtifactType,
  isContextFile,
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
  it('covers the 5 known output locations', () => {
    expect(ARTIFACT_DIRS.map((d) => d.relativeDir).sort()).toEqual([
      'analytics/outputs',
      'discovery/outputs',
      'launch/outputs',
      'specs/outputs',
      'strategy/outputs',
    ]);
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
