import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isInClaudeCodeContext, WRONG_WINDOW_COPY } from '../../src/lib/paste-detect.js';

const CC_ENV_VARS = ['CLAUDECODE', 'CLAUDE_PROJECT_DIR', 'CLAUDE_CODE_ACCOUNT_UUID', 'CLAUDE_CODE_ENTRYPOINT'];

let workDir: string;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'mysecond-paste-'));
  // Save and clear ALL CC env signals so tests don't cross-contaminate
  // (especially important when running inside the CC bash sandbox itself
  // where CLAUDECODE=1 is always present).
  savedEnv = {};
  for (const key of CC_ENV_VARS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of CC_ENV_VARS) {
    if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
    else delete process.env[key];
  }
  rmSync(workDir, { recursive: true, force: true });
});

describe('paste-detect (§6.9 wrong-window detection)', () => {
  // Primary signal: CLAUDECODE=1
  it('returns true when CLAUDECODE=1 (primary fast path)', () => {
    process.env.CLAUDECODE = '1';
    expect(isInClaudeCodeContext('/anywhere')).toBe(true);
  });

  it('returns false when CLAUDECODE is set to something other than "1"', () => {
    process.env.CLAUDECODE = 'true';
    expect(isInClaudeCodeContext(workDir)).toBe(false);
  });

  it('CLAUDECODE=1 rescues fresh project with no .claude/ dir yet (P0 regression)', () => {
    // Real P0 scenario: customer pastes into CC on a fresh empty folder.
    // No .claude/ exists yet. CLAUDECODE=1 is the only reliable signal.
    process.env.CLAUDECODE = '1';
    expect(isInClaudeCodeContext(workDir)).toBe(true);
  });

  // Belt-and-suspenders: CLAUDE_CODE_ACCOUNT_UUID (documented CC env var per anthropic-tools.md)
  it('returns true when CLAUDE_CODE_ACCOUNT_UUID is non-empty', () => {
    process.env.CLAUDE_CODE_ACCOUNT_UUID = 'some-uuid-1234';
    expect(isInClaudeCodeContext('/anywhere')).toBe(true);
  });

  it('does NOT treat CLAUDE_CODE_ACCOUNT_UUID="" as a valid CC signal', () => {
    process.env.CLAUDE_CODE_ACCOUNT_UUID = '';
    expect(isInClaudeCodeContext(workDir)).toBe(false);
  });

  // Belt-and-suspenders: CLAUDE_CODE_ENTRYPOINT (set by CC Desktop/CLI)
  it('returns true when CLAUDE_CODE_ENTRYPOINT is non-empty', () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop';
    expect(isInClaudeCodeContext('/anywhere')).toBe(true);
  });

  // Secondary signal: CLAUDE_PROJECT_DIR (non-empty path)
  it('returns true when CLAUDE_PROJECT_DIR is set to a non-empty path', () => {
    process.env.CLAUDE_PROJECT_DIR = '/some/path';
    expect(isInClaudeCodeContext('/anywhere')).toBe(true);
  });

  // Regression: CC bash sandbox sets CLAUDE_PROJECT_DIR="" (empty string).
  // Previously this caused false-negative: init errored with WRONG_WINDOW_COPY
  // even when running inside Claude Code on a fresh project folder.
  it('does NOT treat CLAUDE_PROJECT_DIR="" as a valid CC signal (falls through to walk)', () => {
    process.env.CLAUDE_PROJECT_DIR = '';
    expect(isInClaudeCodeContext(workDir)).toBe(false);
  });

  // Filesystem walk fallback
  it('returns true when .claude/ dir exists in cwd', () => {
    mkdirSync(join(workDir, '.claude'));
    expect(isInClaudeCodeContext(workDir)).toBe(true);
  });

  it('returns true when .claude/ dir exists in a parent', () => {
    mkdirSync(join(workDir, '.claude'));
    const child = join(workDir, 'sub', 'nested');
    mkdirSync(child, { recursive: true });
    expect(isInClaudeCodeContext(child)).toBe(true);
  });

  it('returns false when no CC env signals and no .claude/ in cwd or parents up to HOME', () => {
    // workDir is under $TMPDIR which is NOT under $HOME on macOS — perfect.
    expect(isInClaudeCodeContext(workDir)).toBe(false);
  });

  it('exposes finalized CXO-7 wrong-window copy with keyboard shortcut hint', () => {
    expect(WRONG_WINDOW_COPY).toContain('Claude Code');
    expect(WRONG_WINDOW_COPY).toContain('Ctrl+`');
    expect(WRONG_WINDOW_COPY).toContain('Cmd+`');
    expect(WRONG_WINDOW_COPY).toContain('mysecond.ai/install');
  });
});
