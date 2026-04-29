import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isInClaudeCodeContext, WRONG_WINDOW_COPY } from '../../src/lib/paste-detect.js';

let workDir: string;
let originalClaudeCode: string | undefined;
let originalProjectDir: string | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'mysecond-paste-'));
  originalClaudeCode = process.env.CLAUDECODE;
  originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
  delete process.env.CLAUDECODE;
  delete process.env.CLAUDE_PROJECT_DIR;
});

afterEach(() => {
  if (originalClaudeCode !== undefined) process.env.CLAUDECODE = originalClaudeCode;
  else delete process.env.CLAUDECODE;
  if (originalProjectDir !== undefined) process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
  else delete process.env.CLAUDE_PROJECT_DIR;
  rmSync(workDir, { recursive: true, force: true });
});

describe('paste-detect (§6.9 wrong-window detection)', () => {
  // Primary signal: CLAUDECODE=1 (reliable across all CC versions + bash sandbox)
  it('returns true when CLAUDECODE=1 (primary fast path)', () => {
    process.env.CLAUDECODE = '1';
    expect(isInClaudeCodeContext('/anywhere')).toBe(true);
  });

  it('returns false when CLAUDECODE is set to something other than "1"', () => {
    process.env.CLAUDECODE = 'true';
    // falls through to .claude/ walk — workDir has no .claude/
    expect(isInClaudeCodeContext(workDir)).toBe(false);
  });

  // Secondary signal: CLAUDE_PROJECT_DIR set to a non-empty path
  it('returns true when CLAUDE_PROJECT_DIR is set to a non-empty path', () => {
    process.env.CLAUDE_PROJECT_DIR = '/some/path';
    expect(isInClaudeCodeContext('/anywhere')).toBe(true);
  });

  // Regression: CC bash sandbox sets CLAUDE_PROJECT_DIR="" (empty string).
  // Previously this caused false-negative: init errored with WRONG_WINDOW_COPY
  // even when running inside Claude Code on a fresh project folder.
  it('does NOT treat CLAUDE_PROJECT_DIR="" as a valid CC signal (falls through to walk)', () => {
    process.env.CLAUDE_PROJECT_DIR = '';
    // workDir has no .claude/ — should be false (not the env-var true path)
    expect(isInClaudeCodeContext(workDir)).toBe(false);
  });

  it('CLAUDECODE=1 rescues fresh project with no .claude/ dir yet', () => {
    // This is the real P0 scenario: customer pastes into CC on a fresh empty folder.
    // No .claude/ exists yet. CLAUDECODE=1 is the only signal available.
    process.env.CLAUDECODE = '1';
    expect(isInClaudeCodeContext(workDir)).toBe(true);
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
