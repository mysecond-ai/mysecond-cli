import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isInClaudeCodeContext, WRONG_WINDOW_COPY } from '../../src/lib/paste-detect.js';

let workDir: string;
let originalEnv: string | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'mysecond-paste-'));
  originalEnv = process.env.CLAUDE_PROJECT_DIR;
  delete process.env.CLAUDE_PROJECT_DIR;
});

afterEach(() => {
  if (originalEnv !== undefined) process.env.CLAUDE_PROJECT_DIR = originalEnv;
  else delete process.env.CLAUDE_PROJECT_DIR;
  rmSync(workDir, { recursive: true, force: true });
});

describe('paste-detect (§6.9 wrong-window detection)', () => {
  it('returns true when CLAUDE_PROJECT_DIR is set (fast path)', () => {
    process.env.CLAUDE_PROJECT_DIR = '/some/path';
    expect(isInClaudeCodeContext('/anywhere')).toBe(true);
  });

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

  it('returns false when no .claude/ in cwd or parents up to HOME', () => {
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
