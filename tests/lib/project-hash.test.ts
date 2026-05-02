// Cross-repo invariant tests for `projectHash()`.
//
// The customer plugin hooks (mysecond-ai/product-manager-os companion-sync)
// compute the same value INLINE using node's built-in crypto:
//   crypto.createHash('sha256').update(project_dir).digest('hex').slice(0, 8)
//
// If the algorithm here ever drifts, every customer's project-scoped credential
// path silently moves to a new directory and they fall back to global creds —
// exactly the silent-401 outage class we already fixed once. These tests
// hardcode expected hashes for known inputs so drift screams.

import { describe, expect, it } from 'vitest';

import { projectHash } from '../../src/lib/project-hash.js';

describe('projectHash — cross-repo invariant', () => {
  // Hash values computed once by `node -e "console.log(require('crypto').createHash('sha256').update(STR).digest('hex').slice(0,8))"`.
  // If you're updating these because the algorithm changed, you MUST also
  // update the hook's inline computation in mysecond-ai/product-manager-os/
  // companion-sync/hooks/{post-tool-use-sync.sh,session-start-sync.sh}.

  const VECTORS: ReadonlyArray<{ input: string; expected: string }> = [
    { input: '/Users/test/proj', expected: 'e8faf588' },
    { input: '/Users/ronyang/Desktop/0501i', expected: '184bd18c' },
    { input: '/tmp/cli-smoke', expected: 'bd4979ab' },
    { input: '', expected: 'e3b0c442' }, // sha256 of empty string, sliced
  ];

  for (const { input, expected } of VECTORS) {
    it(`hashes ${JSON.stringify(input)} → ${expected}`, () => {
      expect(projectHash(input)).toBe(expected);
    });
  }

  it('returns exactly 8 hex characters', () => {
    expect(projectHash('/any/path')).toMatch(/^[a-f0-9]{8}$/);
  });

  it('is deterministic across calls', () => {
    const path = '/Users/abc/def';
    expect(projectHash(path)).toBe(projectHash(path));
  });

  it('is sensitive to single-character changes', () => {
    expect(projectHash('/Users/test/proj')).not.toBe(projectHash('/Users/test/Proj'));
    expect(projectHash('/Users/test/proj')).not.toBe(projectHash('/Users/test/proj/'));
  });
});
