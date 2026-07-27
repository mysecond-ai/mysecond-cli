import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveClaudeBin, __testing } from '../../src/lib/claude-bin.js';
import { installFakeHome, type FakeHome } from '../helpers/fake-home.js';

// Env keys the resolver reads. Save + clear so the CC bash sandbox (which sets
// CLAUDE_CODE_EXECPATH / PATH) can't contaminate these tests. (HOME/USERPROFILE
// are additionally sandboxed via installFakeHome below.)
const ENV_KEYS = ['CLAUDE_CODE_EXECPATH', 'PATH', 'PATHEXT', 'HOME', 'LOCALAPPDATA'];

const IS_WIN = process.platform === 'win32';
// The single extension the suite pins PATHEXT to on win32, so the resolver's
// PATH candidates are deterministic: join(dir, 'claude' + WIN_EXT). Fixtures use
// the same casing so the resolver's returned string equals the fixture path.
const WIN_EXT = '.CMD';

let workDir: string;
let saved: Record<string, string | undefined> = {};
let fake: FakeHome;

function makeExecutable(dir: string, name = 'claude'): string {
  if (IS_WIN) {
    // NTFS has no POSIX exec bit — "executable" on win32 means a PATHEXT-suffixed
    // file. Suite pins PATHEXT to WIN_EXT so this is the candidate probed.
    const p = join(dir, `${name}${WIN_EXT}`);
    writeFileSync(p, '@echo ok\r\n');
    return p;
  }
  const p = join(dir, name);
  writeFileSync(p, '#!/bin/sh\necho ok\n');
  chmodSync(p, 0o755);
  return p;
}

// POSIX-only: relies on mode bits (0o644). Only used by tests that are
// skipIf(win32) — NTFS cannot express "exists but not executable".
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
  // Sandbox the home dir so known-location probing can't accidentally hit a
  // real install on the dev/runner machine. Sets BOTH HOME and USERPROFILE —
  // os.homedir() reads USERPROFILE on win32, so HOME alone sandboxes nothing there.
  fake = installFakeHome();
  if (IS_WIN) process.env.PATHEXT = WIN_EXT;
  __testing.reset();
});

afterEach(() => {
  // Restore HOME/USERPROFILE first; the ENV_KEYS loop then re-applies the
  // originally saved HOME (USERPROFILE is owned entirely by installFakeHome).
  fake.restore();
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

  // skipIf(win32): NTFS cannot express POSIX mode bits; accessSync X_OK degrades
  // to F_OK, so an "exists but non-executable" execpath is physically impossible
  // to construct on win32 — the guarded scenario only exists on POSIX.
  it.skipIf(process.platform === 'win32')('does NOT shadow a working PATH claude when execpath is non-executable (regression)', () => {
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

  // skipIf(win32): NTFS cannot express POSIX mode bits; accessSync X_OK degrades
  // to F_OK, so a persisted path that exists-but-lost-its-exec-bit cannot be
  // fabricated on win32 — the staleness this guards is POSIX-only.
  it.skipIf(process.platform === 'win32')('ignores a stale persisted candidate that is no longer executable', () => {
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

  it('resolves a known native-install location (platform-specific probe list)', () => {
    // No execpath, no persisted, nothing on PATH → known locations.
    // win32 branch probes %USERPROFILE%\.local\bin\claude.exe (LOCALAPPDATA is
    // cleared by the suite, so the Programs\claude probe is inert); POSIX
    // probes ~/.claude/local/claude first.
    let known: string;
    if (IS_WIN) {
      const binDir = join(fake.home, '.local', 'bin');
      mkdirSync(binDir, { recursive: true });
      known = join(binDir, 'claude.exe');
      // Presence is enough: on win32 accessSync X_OK degrades to F_OK.
      writeFileSync(known, '@echo ok\r\n');
    } else {
      const localDir = join(fake.home, '.claude', 'local');
      mkdirSync(localDir, { recursive: true });
      known = makeExecutable(localDir);
    }
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
