import {
  existsSync,
  mkdirSync as fsMkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  atomicRenameDir,
  atomicWriteFile,
  coupledAtomicWrite,
  rmDirRecursive,
} from '../../src/lib/atomic-write.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'mysecond-atomic-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('atomicWriteFile', () => {
  it('writes content via temp + rename', () => {
    const path = join(workDir, 'foo.txt');
    atomicWriteFile(path, 'hello');
    expect(readFileSync(path, 'utf8')).toBe('hello');
  });

  it('mkdirRecursive creates parent dirs when requested', () => {
    const path = join(workDir, 'deep', 'nested', 'foo.txt');
    atomicWriteFile(path, 'hi', { mkdirRecursive: true });
    expect(readFileSync(path, 'utf8')).toBe('hi');
  });

  it('overwrites existing file atomically', () => {
    const path = join(workDir, 'foo.txt');
    writeFileSync(path, 'old');
    atomicWriteFile(path, 'new');
    expect(readFileSync(path, 'utf8')).toBe('new');
  });

  it('leaves no .tmp-{pid} file after success', () => {
    const path = join(workDir, 'foo.txt');
    atomicWriteFile(path, 'x');
    const entries = readdirSync(workDir);
    expect(entries.filter((e) => e.includes('.tmp-'))).toHaveLength(0);
  });
});

describe('coupledAtomicWrite', () => {
  it('writes multiple files in coupled-rename order', () => {
    const a = join(workDir, 'a.txt');
    const b = join(workDir, 'b.txt');
    coupledAtomicWrite([
      { path: a, content: 'aa' },
      { path: b, content: 'bb' },
    ]);
    expect(readFileSync(a, 'utf8')).toBe('aa');
    expect(readFileSync(b, 'utf8')).toBe('bb');
  });
});

describe('atomicRenameDir (CTO P1-2 cross-platform fix)', () => {
  it('replaces non-empty destination dir on macOS/Linux', () => {
    const src = join(workDir, 'src');
    const dest = join(workDir, 'dest');
    // Create a non-empty destination — fs.renameSync alone would fail with
    // ENOTEMPTY on macOS. atomicRenameDir handles via rm + rename.
    writeFileSync(join(workDir, 'src.tmp'), '');
    rmSync(join(workDir, 'src.tmp'));
    // Build src + dest both with content.
    writeFileSync(join(workDir, 'src-pre'), '');
    rmSync(join(workDir, 'src-pre'));

    // Use mkdir to build src and dest dirs.
    fsMkdirSync(src);
    writeFileSync(join(src, 'inner.txt'), 'fresh');
    fsMkdirSync(dest);
    writeFileSync(join(dest, 'old.txt'), 'old');

    atomicRenameDir(src, dest);

    expect(existsSync(src)).toBe(false);
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(join(dest, 'inner.txt'), 'utf8')).toBe('fresh');
    expect(existsSync(join(dest, 'old.txt'))).toBe(false);
  });
});

describe('rmDirRecursive', () => {
  it('is a no-op on missing dirs (force: true)', () => {
    expect(() => rmDirRecursive(join(workDir, 'nope'))).not.toThrow();
  });

  it('removes nested dirs', () => {
    fsMkdirSync(join(workDir, 'a', 'b'), { recursive: true });
    writeFileSync(join(workDir, 'a', 'b', 'c.txt'), '');
    rmDirRecursive(join(workDir, 'a'));
    expect(existsSync(join(workDir, 'a'))).toBe(false);
  });
});
