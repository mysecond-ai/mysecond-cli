// Codex blocking #1 regression: scanArtifacts must be safe to run as a per-turn
// Stop sweep. walkArtifactDir now stats first, skips empties + anything over the
// server's artifact cap, and catches read errors — so one giant/transient file
// can't OOM or throw the whole `sync --push-only`.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { scanArtifacts, ARTIFACT_PER_FILE_LIMIT } from '../../src/lib/payload.js';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'mysecond-scan-'));
}

describe('scanArtifacts hardening', () => {
  it('skips artifacts over the server size cap (OOM/stall guard)', () => {
    const root = tmpProject();
    mkdirSync(join(root, 'work/specs/outputs'), { recursive: true });
    writeFileSync(join(root, 'work/specs/outputs/small.md'), 'ok content');
    writeFileSync(join(root, 'work/specs/outputs/huge.md'), 'x'.repeat(ARTIFACT_PER_FILE_LIMIT + 1));

    const found = scanArtifacts(root).map((a) => a.file_path);
    expect(found).toContain('work/specs/outputs/small.md');
    expect(found.some((p) => p.endsWith('huge.md'))).toBe(false);
  });

  it('skips empty artifact files', () => {
    const root = tmpProject();
    mkdirSync(join(root, 'work/specs/outputs'), { recursive: true });
    writeFileSync(join(root, 'work/specs/outputs/empty.md'), '');
    writeFileSync(join(root, 'work/specs/outputs/real.md'), 'content');

    const found = scanArtifacts(root).map((a) => a.file_path);
    expect(found.some((p) => p.endsWith('empty.md'))).toBe(false);
    expect(found.some((p) => p.endsWith('real.md'))).toBe(true);
  });

  it('keeps a file exactly at the cap (boundary: skip only when strictly over)', () => {
    const root = tmpProject();
    mkdirSync(join(root, 'work/specs/outputs'), { recursive: true });
    writeFileSync(join(root, 'work/specs/outputs/atcap.md'), 'x'.repeat(ARTIFACT_PER_FILE_LIMIT));

    const found = scanArtifacts(root).map((a) => a.file_path);
    expect(found.some((p) => p.endsWith('atcap.md'))).toBe(true);
  });
});
