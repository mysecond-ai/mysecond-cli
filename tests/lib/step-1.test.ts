// Tests for step-1 claude-version floor (CAIO Y-CC-Floor).
//
// Strategy: inject a fake ClaudeVersionProbe so we don't need a real claude
// binary. Verifies the Node check still fires + the new Claude Code version
// gate rejects old versions / missing binary / passes current + future versions.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compareVersions,
  MIN_CLAUDE_CODE_VERSION,
  parseClaudeVersion,
  step1,
  __setClaudeVersionProbe,
  __resetClaudeVersionProbe,
  type ClaudeProbeResult,
} from '../../src/lib/steps/step-1.js';
import { MysecondError } from '../../src/lib/errors.js';
import type { StepContext } from '../../src/lib/steps/types.js';

const originalEnv = { ...process.env };

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'mysecond-step1-test-'));
  __resetClaudeVersionProbe();
});

afterEach(() => {
  rmSync(tmpRoot, { force: true, recursive: true });
  process.env = { ...originalEnv };
  __resetClaudeVersionProbe();
});

function fakeCtx(rootDir = tmpRoot): StepContext {
  return {
    ctx: {
      rootDir,
      apiKey: 'msk_test',
      baseUrl: 'https://app.mysecond.ai',
      silent: true,
      dryRun: false,
      fix: false,
    },
    state: {},
    shared: {},
  } as unknown as StepContext;
}

function fakeProbe(result: ClaudeProbeResult) {
  return () => result;
}

describe('parseClaudeVersion', () => {
  it('parses bare semver', () => {
    expect(parseClaudeVersion('2.1.118')).toEqual([2, 1, 118]);
  });

  it('parses "claude 2.1.118" form', () => {
    expect(parseClaudeVersion('claude 2.1.118')).toEqual([2, 1, 118]);
  });

  it('parses "Claude Code 2.1.118" form', () => {
    expect(parseClaudeVersion('Claude Code 2.1.118')).toEqual([2, 1, 118]);
  });

  it('parses "2.1.118 (Claude Code)" form', () => {
    expect(parseClaudeVersion('2.1.118 (Claude Code)')).toEqual([2, 1, 118]);
  });

  it('handles double-digit minor/patch', () => {
    expect(parseClaudeVersion('10.20.30')).toEqual([10, 20, 30]);
  });

  it('returns null on unparseable strings', () => {
    expect(parseClaudeVersion('some other string')).toBeNull();
    expect(parseClaudeVersion('2.1')).toBeNull(); // missing patch
    expect(parseClaudeVersion('')).toBeNull();
  });
});

describe('compareVersions', () => {
  it('returns zero on equal', () => {
    expect(compareVersions([2, 1, 118], [2, 1, 118])).toBe(0);
  });

  it('returns negative when first is older', () => {
    expect(compareVersions([2, 1, 117], [2, 1, 118])).toBeLessThan(0);
    expect(compareVersions([2, 0, 999], [2, 1, 0])).toBeLessThan(0);
    expect(compareVersions([1, 99, 99], [2, 0, 0])).toBeLessThan(0);
  });

  it('returns positive when first is newer', () => {
    expect(compareVersions([2, 1, 119], [2, 1, 118])).toBeGreaterThan(0);
    expect(compareVersions([3, 0, 0], [2, 99, 99])).toBeGreaterThan(0);
  });
});

describe('step1 — Claude Code version gate', () => {
  it('passes on exact floor version', async () => {
    __setClaudeVersionProbe(
      fakeProbe({ kind: 'ok', version: [2, 1, 118], raw: '2.1.118' })
    );
    const result = await step1(fakeCtx());
    expect(result.outcome.kind).toBe('completed');
  });

  it('passes on newer version', async () => {
    __setClaudeVersionProbe(
      fakeProbe({ kind: 'ok', version: [2, 1, 200], raw: '2.1.200' })
    );
    const result = await step1(fakeCtx());
    expect(result.outcome.kind).toBe('completed');
  });

  it('passes on much newer version', async () => {
    __setClaudeVersionProbe(
      fakeProbe({ kind: 'ok', version: [3, 0, 0], raw: '3.0.0' })
    );
    const result = await step1(fakeCtx());
    expect(result.outcome.kind).toBe('completed');
  });

  it('rejects older patch version with claudeCodeTooOld (exit 5)', async () => {
    __setClaudeVersionProbe(
      fakeProbe({ kind: 'ok', version: [2, 1, 117], raw: '2.1.117' })
    );
    await expect(step1(fakeCtx())).rejects.toMatchObject({
      exitCode: 5,
      subCode: 'claude_code_too_old',
    });
  });

  it('rejects older minor version', async () => {
    __setClaudeVersionProbe(
      fakeProbe({ kind: 'ok', version: [2, 0, 500], raw: '2.0.500' })
    );
    await expect(step1(fakeCtx())).rejects.toMatchObject({
      exitCode: 5,
      subCode: 'claude_code_too_old',
    });
  });

  it('rejects older major version', async () => {
    __setClaudeVersionProbe(
      fakeProbe({ kind: 'ok', version: [1, 99, 999], raw: '1.99.999' })
    );
    await expect(step1(fakeCtx())).rejects.toMatchObject({
      exitCode: 5,
      subCode: 'claude_code_too_old',
    });
  });

  it('error message cites the required version so customer knows what to upgrade to', async () => {
    __setClaudeVersionProbe(
      fakeProbe({ kind: 'ok', version: [2, 1, 100], raw: '2.1.100' })
    );
    try {
      await step1(fakeCtx());
      throw new Error('expected throw');
    } catch (err) {
      const e = err as MysecondError;
      expect(e.message).toContain(MIN_CLAUDE_CODE_VERSION);
      expect(e.message).toContain('2.1.100');
    }
  });

  it('rejects when claude binary not detected (ENOENT / non-zero)', async () => {
    __setClaudeVersionProbe(fakeProbe({ kind: 'not_detected' }));
    await expect(step1(fakeCtx())).rejects.toMatchObject({
      exitCode: 5,
      subCode: 'claude_code_too_old',
    });
  });

  it('not-detected error copy guides customer to Claude Code bash tool', async () => {
    __setClaudeVersionProbe(fakeProbe({ kind: 'not_detected' }));
    try {
      await step1(fakeCtx());
      throw new Error('expected throw');
    } catch (err) {
      const e = err as MysecondError;
      expect(e.message).toContain('Claude Code');
      expect(e.message.toLowerCase()).toContain('bash');
    }
  });

  it('passes through when version output is unparseable (forward-compat for future CC releases)', async () => {
    __setClaudeVersionProbe(
      fakeProbe({ kind: 'unparseable', raw: 'ClaudeCode-NEXT-GA 2026-q3' })
    );
    const result = await step1(fakeCtx());
    expect(result.outcome.kind).toBe('completed');
  });
});
