import { describe, expect, it } from 'vitest';

import { ARTIFACT_DIRS, classifyArtifactType } from '../../src/lib/payload.js';

describe('classifyArtifactType', () => {
  it('classifies known artifact dirs', () => {
    expect(classifyArtifactType('specs/outputs/foo.md')).toBe('prd');
    expect(classifyArtifactType('strategy/outputs/bar.md')).toBe('strategy');
    expect(classifyArtifactType('discovery/outputs/baz.md')).toBe('research');
    expect(classifyArtifactType('launch/outputs/x.md')).toBe('launch');
    expect(classifyArtifactType('analytics/outputs/y.md')).toBe('other');
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
