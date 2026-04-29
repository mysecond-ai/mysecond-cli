import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  deleteLocalFile,
  projectPaths,
  readLocalFile,
  safePath,
  sha256,
  shortHash,
  writeLocalFile,
} from '../../src/lib/files.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'mysecond-files-'));
}

describe('sha256 / shortHash', () => {
  it('hashes deterministically', () => {
    expect(sha256('hello')).toBe(sha256('hello'));
    expect(sha256('hello')).not.toBe(sha256('world'));
  });

  it('shortHash returns 12 hex chars', () => {
    expect(shortHash('anything')).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('safePath', () => {
  const base = '/Users/test/project';

  it('accepts a normal relative path', () => {
    expect(safePath(base, 'context/company.md')).toBe(`${base}/context/company.md`);
  });

  it('rejects absolute paths', () => {
    expect(safePath(base, '/etc/passwd')).toBeNull();
  });

  it('rejects path traversal', () => {
    expect(safePath(base, '../../../etc/passwd')).toBeNull();
    expect(safePath(base, 'subdir/../../escape')).toBeNull();
  });

  it('handles dot-prefix files safely', () => {
    expect(safePath(base, '.env')).toBe(`${base}/.env`);
  });
});

describe('writeLocalFile / readLocalFile / deleteLocalFile', () => {
  it('writes, reads, and deletes a file under baseDir', () => {
    const base = tmpDir();
    const ok = writeLocalFile(base, 'sub/dir/file.md', 'hello');
    expect(ok).toBe(true);
    expect(readLocalFile(base, 'sub/dir/file.md')).toBe('hello');
    expect(deleteLocalFile(base, 'sub/dir/file.md')).toBe(true);
    expect(readLocalFile(base, 'sub/dir/file.md')).toBeNull();
  });

  it('refuses to write outside baseDir', () => {
    const base = tmpDir();
    const ok = writeLocalFile(base, '../escape.md', 'malicious');
    expect(ok).toBe(false);
  });

  it('does not delete parent dirs that still have content', () => {
    const base = tmpDir();
    writeLocalFile(base, 'a/b/file1.md', '1');
    writeLocalFile(base, 'a/b/file2.md', '2');
    deleteLocalFile(base, 'a/b/file1.md');
    expect(readLocalFile(base, 'a/b/file2.md')).toBe('2');
  });
});

describe('projectPaths', () => {
  it('builds expected layout', () => {
    const p = projectPaths('/proj');
    expect(p.contextDir).toBe('/proj/context');
    expect(p.skillsDir).toBe('/proj/.claude/skills');
    expect(p.agentsDir).toBe('/proj/.claude/agents');
    expect(p.workflowsDir).toBe('/proj/workflows');
    expect(p.claudeMdPath).toBe('/proj/CLAUDE.md');
    expect(p.syncStatePath).toBe('/proj/.claude/sync-state.json');
    expect(p.conflictsDir).toBe('/proj/.claude/sync-conflicts');
  });
});

describe('readLocalFile error handling', () => {
  it('returns null when file does not exist', () => {
    const base = tmpDir();
    expect(readLocalFile(base, 'nope.md')).toBeNull();
  });

  it('returns null for an unsafe path', () => {
    const base = tmpDir();
    expect(readLocalFile(base, '/etc/passwd')).toBeNull();
  });
});
