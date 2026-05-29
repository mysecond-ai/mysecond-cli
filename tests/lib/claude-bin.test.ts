import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveClaudeBin, __testing } from '../../src/lib/claude-bin.js';

// Env keys the resolver reads. Save + clear so the CC bash sandbox (which sets
// CLAUDE_CODE_EXECPATH / PATH) can't contaminate these tests.
const ENV_KEYS = ['CLAUDE_CODE_EXECPATH', 'PATH', 'PATHEXT', 'HOME', 'LOCALAPPDATA'];

let workDir: string;
let saved: Record<string, string | undefined> = {};

function makeExecutable(dir: string, name = 'claude'): string {
  const p = join(dir, name);
  writeFileSync(p, '#!/bin/sh\necho ok\n');
  chmodSync(p, 0o755);
  return p;
}

function makeNonExecutable(dir: string, name = 'claude'): string {
  const p = join(dir, name);
  writeFileSync(p, 'not executable\n');
  chmodSync(p, 0o644);
  return p;
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'mysecond-claudebin-'));
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // Point HOME at an empty dir so known-location probing can't accidentally hit
  // a real ~/.claude/local/claude on the dev machine.
  process.env.HOME = mkdtempSync(join(tmpdir(), 'mysecond-home-'));
  __testing.reset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] !== undefined) process.env[k] = saved[k];
    else delete process.env[k];
  }
  rmSync(workDir, { recursive: true, force: true });
  __testing.reset();
});

describe('resolveClaudeBin', () => {
  it('prefers CLAUDE_CODE_EXECPATH when it points at an executable', () => {
    const exec = makeExecutable(workDir);
    process.env.CLAUDE_CODE_EXECPATH = exec;
    const r = resolveClaudeBin();
    expect(r).toEqual({ path: exec, source: 'execpath' });
  });

  it('falls through and fires onExecpathStale when execpath is set but missing', () => {
    process.env.CLAUDE_CODE_EXECPATH = join(workDir, 'gone', 'claude'); // does not exist
    const onExecpathStale = vi.fn();
    // PATH has a working claude so we have somewhere to fall through to.
    const pathDir = mkdtempSync(join(tmpdir(), 'mysecond-path-'));
    makeExecutable(pathDir);
    process.env.PATH = pathDir;

    const r = resolveClaudeBin({ onExecpathStale });
    expect(r.source).toBe('path');
    expect(onExecpathStale).toHaveBeenCalledOnce();
    rmSync(pathDir, { recursive: true, force: true });
  });

  it('does NOT shadow a working PATH claude when execpath is non-executable (regression)', () => {
    // execpath set but NOT executable (EACCES). A naive existsSync check would
    // pick it and then spawn would EACCES — the resolver must fall through to
    // the working PATH binary so today's npm-CLI customers keep working.
    process.env.CLAUDE_CODE_EXECPATH = makeNonExecutable(workDir);
    const pathDir = mkdtempSync(join(tmpdir(), 'mysecond-path-'));
    const pathClaude = makeExecutable(pathDir);
    process.env.PATH = pathDir;

    const r = resolveClaudeBin();
    expect(r).toEqual({ path: pathClaude, source: 'path' });
    rmSync(pathDir, { recursive: true, force: true });
  });

  it('uses the persisted candidate when execpath is unset (plain-terminal case)', () => {
    const persisted = makeExecutable(workDir);
    // No execpath (plain terminal). Persisted path resolves before PATH.
    const r = resolveClaudeBin({ persistedPath: persisted });
    expect(r).toEqual({ path: persisted, source: 'persisted' });
  });

  it('ignores a stale persisted candidate that is no longer executable', () => {
    const persisted = makeNonExecutable(workDir);
    const pathDir = mkdtempSync(join(tmpdir(), 'mysecond-path-'));
    const pathClaude = makeExecutable(pathDir);
    process.env.PATH = pathDir;
    const r = resolveClaudeBin({ persistedPath: persisted });
    expect(r).toEqual({ path: pathClaude, source: 'path' });
    rmSync(pathDir, { recursive: true, force: true });
  });

  it('walks PATH (multiple dirs) and picks the first executable claude', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'mysecond-empty-'));
    const pathDir = mkdtempSync(join(tmpdir(), 'mysecond-path-'));
    const pathClaude = makeExecutable(pathDir);
    process.env.PATH = [emptyDir, pathDir].join(delimiter);
    const r = resolveClaudeBin();
    expect(r).toEqual({ path: pathClaude, source: 'path' });
    rmSync(emptyDir, { recursive: true, force: true });
    rmSync(pathDir, { recursive: true, force: true });
  });

  it('resolves a known native-install location (~/.claude/local/claude)', () => {
    // No execpath, no persisted, nothing on PATH → known locations.
    const localDir = join(process.env.HOME as string, '.claude', 'local');
    mkdirSync(localDir, { recursive: true });
    const known = makeExecutable(localDir);
    process.env.PATH = mkdtempSync(join(tmpdir(), 'mysecond-empty-')); // no claude here
    const r = resolveClaudeBin();
    expect(r).toEqual({ path: known, source: 'known-location' });
  });

  it('falls back to bare claude when nothing resolves (never throws)', () => {
    process.env.PATH = mkdtempSync(join(tmpdir(), 'mysecond-empty-')); // no claude anywhere
    const r = resolveClaudeBin();
    expect(r).toEqual({ path: 'claude', source: 'fallback' });
  });
});
