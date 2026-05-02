// Tests for step-5b — project-scoped credential write + migration + gitignore guard.
//
// Each test isolates HOME and CLAUDE_PROJECT_DIR via tmp dirs so we don't
// pollute the user's real ~/.mysecond/projects/ tree. We mock console output
// via a stderr/stdout sniffer.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runGitignoreGuard, step5b } from '../../src/lib/steps/step-5b.js';
import { projectHash } from '../../src/lib/project-hash.js';
import type { CommandContext } from '../../src/lib/context.js';
import type { SyncState } from '../../src/lib/sync-state.js';
import type { StepContext } from '../../src/lib/steps/types.js';

const TEST_KEY = 'mysecond_test_abc123def456';

let originalHome: string;
let tmpRoot: string;
let projectDir: string;

function makeStepCtx(overrides: Partial<CommandContext> = {}): StepContext {
  const ctx: CommandContext = {
    apiBase: 'https://app.mysecond.ai',
    apiKey: TEST_KEY,
    rootDir: projectDir,
    silent: false,
    dryRun: false,
    forceUpdate: false,
    fix: false,
    strategy: 'prompt',
    ...overrides,
  };
  const state: SyncState = {
    initCompletedSteps: [],
    step9Auth401RetryCount: 0,
  } as SyncState;
  return { ctx, state, shared: {} };
}

beforeEach(() => {
  // Isolate HOME — each test gets a fresh tmp HOME so ~/.mysecond/projects/
  // writes don't escape into the real user dir.
  originalHome = process.env.HOME ?? homedir();
  tmpRoot = mkdtempSync(join(tmpdir(), 'cli-step5b-'));
  process.env.HOME = tmpRoot;

  // Fresh project dir per test.
  projectDir = mkdtempSync(join(tmpdir(), 'cli-step5b-proj-'));
});

afterEach(() => {
  process.env.HOME = originalHome;
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
  try {
    rmSync(projectDir, { recursive: true, force: true });
  } catch {}
  vi.restoreAllMocks();
});

describe('step-5b — project-scoped credential write', () => {
  it('writes COMPANION_API_KEY to ~/.mysecond/projects/<hash>/credentials', async () => {
    if (process.platform === 'win32') return; // Windows skip path tested separately
    await step5b(makeStepCtx());

    const credsPath = join(
      tmpRoot,
      '.mysecond',
      'projects',
      projectHash(projectDir),
      'credentials'
    );
    expect(existsSync(credsPath)).toBe(true);
    expect(readFileSync(credsPath, 'utf8')).toBe(`COMPANION_API_KEY=${TEST_KEY}\n`);
  });

  it('credential file is chmod 600', async () => {
    if (process.platform === 'win32') return;
    await step5b(makeStepCtx());
    const credsPath = join(
      tmpRoot,
      '.mysecond',
      'projects',
      projectHash(projectDir),
      'credentials'
    );
    const mode = statSync(credsPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('parent directory is chmod 700 (info-leak mitigation)', async () => {
    if (process.platform === 'win32') return;
    await step5b(makeStepCtx());
    const credsDir = join(tmpRoot, '.mysecond', 'projects', projectHash(projectDir));
    const mode = statSync(credsDir).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('idempotent: re-running with same key is a no-op (no error)', async () => {
    if (process.platform === 'win32') return;
    await step5b(makeStepCtx());
    const credsPath = join(
      tmpRoot,
      '.mysecond',
      'projects',
      projectHash(projectDir),
      'credentials'
    );
    const mtime1 = statSync(credsPath).mtimeMs;
    // Wait a tick to ensure mtime would change if we rewrote.
    await new Promise((r) => setTimeout(r, 10));
    await step5b(makeStepCtx());
    // We don't strictly assert mtime didn't change (atomic-write rewrites
    // every time), but the test asserts no crash + content unchanged.
    expect(existsSync(credsPath)).toBe(true);
    expect(readFileSync(credsPath, 'utf8')).toBe(`COMPANION_API_KEY=${TEST_KEY}\n`);
  });

  it('drift case: project-scoped has DIFFERENT key — does NOT overwrite + warns', async () => {
    if (process.platform === 'win32') return;
    const credsDir = join(tmpRoot, '.mysecond', 'projects', projectHash(projectDir));
    mkdirSync(credsDir, { recursive: true, mode: 0o700 });
    const credsPath = join(credsDir, 'credentials');
    writeFileSync(credsPath, 'COMPANION_API_KEY=manually-edited-key\n', { mode: 0o600 });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await step5b(makeStepCtx());

    // File still has the manually-edited value (no overwrite).
    expect(readFileSync(credsPath, 'utf8')).toBe('COMPANION_API_KEY=manually-edited-key\n');
    // Warning was emitted to stderr.
    const warnings = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(warnings).toContain('different COMPANION_API_KEY');
  });
});

describe('step-5b — migration messaging', () => {
  it('logs migration message when .env exists but project-scoped is fresh', async () => {
    if (process.platform === 'win32') return;
    // Seed .env to simulate an existing customer.
    writeFileSync(join(projectDir, '.env'), `COMPANION_API_KEY=${TEST_KEY}\n`);

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await step5b(makeStepCtx());

    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toContain('Secured your API key');
    expect(out).toContain('mysecond whereami');
  });
});

describe('step-5b — gitignore guard', () => {
  it('skips gitignore mutation if not a git repo', async () => {
    if (process.platform === 'win32') return;
    await step5b(makeStepCtx());
    expect(existsSync(join(projectDir, '.gitignore'))).toBe(false);
  });

  it('appends .env to .gitignore in a git repo (initialized but no commits)', async () => {
    if (process.platform === 'win32') return;
    // Make it a git repo (no commit needed for gitignore guard to fire).
    mkdirSync(join(projectDir, '.git'), { recursive: true });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await step5b(makeStepCtx());

    const gitignorePath = join(projectDir, '.gitignore');
    expect(existsSync(gitignorePath)).toBe(true);
    expect(readFileSync(gitignorePath, 'utf8')).toContain('.env');

    // Pre-write notice was printed.
    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toContain('Adding `.env` to .gitignore');
  });

  it('does NOT duplicate .env when already in .gitignore', async () => {
    if (process.platform === 'win32') return;
    mkdirSync(join(projectDir, '.git'), { recursive: true });
    writeFileSync(join(projectDir, '.gitignore'), 'node_modules\n.env\n');
    await step5b(makeStepCtx());
    const lines = readFileSync(join(projectDir, '.gitignore'), 'utf8').split('\n');
    const envLines = lines.filter((l) => l.trim() === '.env');
    expect(envLines.length).toBe(1);
  });

  it('LOUD warning when .env is git-tracked (gitignore append is a no-op)', async () => {
    if (process.platform === 'win32') return;
    // Skip if git binary not available in test env.
    try {
      execFileSync('git', ['--version'], { stdio: 'pipe' });
    } catch {
      return;
    }

    // Create a real git repo and commit .env to it.
    execFileSync('git', ['init', '-q'], { cwd: projectDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: projectDir });
    writeFileSync(join(projectDir, '.env'), `COMPANION_API_KEY=${TEST_KEY}\n`);
    execFileSync('git', ['add', '.env'], { cwd: projectDir });
    execFileSync('git', ['commit', '-q', '-m', 'oops'], { cwd: projectDir });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await step5b(makeStepCtx());

    const warnings = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(warnings).toContain('SECURITY');
    expect(warnings).toContain('.env is tracked by git');
    expect(warnings).toContain('git rm --cached');
  });
});

describe('step-5b — fault tolerance', () => {
  it('mkdir failure → falls back to .env-only + warning, does not throw', async () => {
    if (process.platform === 'win32') return;
    // Make ~/.mysecond a regular FILE so mkdirSync inside it must fail.
    writeFileSync(join(tmpRoot, '.mysecond'), 'not-a-directory');

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await expect(step5b(makeStepCtx())).resolves.toBeDefined();

    const warnings = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(warnings).toContain('Could not create');
    expect(warnings).toContain('Falling back');
  });

  it('Windows guard: skips with informational log', async () => {
    const platSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await step5b(makeStepCtx());

    // No project-scoped file written.
    const credsPath = join(
      tmpRoot,
      '.mysecond',
      'projects',
      projectHash(projectDir),
      'credentials'
    );
    expect(existsSync(credsPath)).toBe(false);

    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toContain('Skipping project-scoped credential storage on Windows');

    platSpy.mockRestore();
  });
});

describe('step-5b — clean install (no .env present)', () => {
  it('writes project-scoped credentials without requiring an existing .env', async () => {
    if (process.platform === 'win32') return;
    expect(existsSync(join(projectDir, '.env'))).toBe(false);
    await step5b(makeStepCtx());
    const credsPath = join(
      tmpRoot,
      '.mysecond',
      'projects',
      projectHash(projectDir),
      'credentials'
    );
    expect(existsSync(credsPath)).toBe(true);
    expect(readFileSync(credsPath, 'utf8')).toContain(TEST_KEY);
  });
});

describe('runGitignoreGuard — orphan-migration safety (called from init-runner on step-5 throw)', () => {
  it('exported for init-runner to call independently', () => {
    expect(typeof runGitignoreGuard).toBe('function');
  });

  it('appends .env to .gitignore when called standalone in a git repo', () => {
    if (process.platform === 'win32') return;
    mkdirSync(join(projectDir, '.git'), { recursive: true });
    runGitignoreGuard(projectDir, false);
    expect(readFileSync(join(projectDir, '.gitignore'), 'utf8')).toContain('.env');
  });

  it('skips silently if not a git repo (no orphan .gitignore created)', () => {
    if (process.platform === 'win32') return;
    runGitignoreGuard(projectDir, false);
    expect(existsSync(join(projectDir, '.gitignore'))).toBe(false);
  });

  it('still emits SECURITY warning when .env is git-tracked, even on orphan path', () => {
    if (process.platform === 'win32') return;
    try {
      execFileSync('git', ['--version'], { stdio: 'pipe' });
    } catch {
      return;
    }
    execFileSync('git', ['init', '-q'], { cwd: projectDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: projectDir });
    writeFileSync(join(projectDir, '.env'), `COMPANION_API_KEY=${TEST_KEY}\n`);
    execFileSync('git', ['add', '.env'], { cwd: projectDir });
    execFileSync('git', ['commit', '-q', '-m', 'oops'], { cwd: projectDir });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    runGitignoreGuard(projectDir, false);
    const warnings = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(warnings).toContain('SECURITY');
    expect(warnings).toContain('.env is tracked by git');
  });
});
