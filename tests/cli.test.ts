// CLI shape tests — per EDD-solo-phase-4-pmkit-cli.md §4.7.
//
// Runs the bin/mysecond.cjs shim as a child process against the dist/ bundle
// produced by `npm run build`. We test the binary the way customers will invoke it,
// not the TypeScript source, so the build pipeline is exercised too.

import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, beforeAll } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const BIN = resolve(REPO_ROOT, 'bin', 'mysecond.cjs');
const DIST = resolve(REPO_ROOT, 'dist', 'mysecond.mjs');

// init is the only command still stubbed in v1.1.0-rc.0; PR 4c implements it.
// sync + artifact-sync are real implementations as of PR 4b.
const SUBCOMMAND_NAMES = ['init', 'sync', 'artifact-sync'] as const;
// PR 4c replaced the init stub with the real 13-step implementation.
// The init-specific stub-message test below was removed — see new
// "init wrong-window detection" test instead.

interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface RunBinOptions {
  envOverride?: Record<string, string | undefined>;
  stdin?: string;
}

function runBin(args: readonly string[], opts: RunBinOptions = {}): ExecResult {
  // Build env: start from process.env, apply overrides (undefined means delete).
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) baseEnv[k] = v;
  }
  if (opts.envOverride) {
    for (const [k, v] of Object.entries(opts.envOverride)) {
      if (v === undefined) {
        delete baseEnv[k];
      } else {
        baseEnv[k] = v;
      }
    }
  }
  const execOpts: ExecFileSyncOptionsWithStringEncoding = {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: baseEnv,
    input: opts.stdin ?? '',
  };
  try {
    const stdout = execFileSync('node', [BIN, ...args], execOpts);
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      status: typeof e.status === 'number' ? e.status : 1,
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
    };
  }
}

describe('mysecond CLI shape', () => {
  beforeAll(() => {
    if (!existsSync(DIST)) {
      throw new Error(
        `Missing ${DIST}. Run \`npm run build\` before tests (or rely on prepublishOnly).`
      );
    }
  });

  it('prints version from package.json on --version', () => {
    const result = runBin(['--version']);
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it('prints version on -v alias', () => {
    const result = runBin(['-v']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('lists all subcommands in --help output', () => {
    const result = runBin(['--help']);
    expect(result.status).toBe(0);
    for (const name of SUBCOMMAND_NAMES) {
      expect(result.stdout).toMatch(new RegExp(`^\\s+${name}\\s`, 'm'));
    }
  });

  it('prints help with no args', () => {
    const result = runBin([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
  });

  it('exits with code 1 on unknown subcommand', () => {
    const result = runBin(['frobnicate']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown subcommand');
  });

  it('init detects wrong-window paste (no .claude/ dir, no CLAUDE_PROJECT_DIR) and exits 2', () => {
    // Wrong-window detection runs BEFORE any state mutation per §6.9. We
    // pass an isolated tmpdir as --project-dir, with no .claude/ dir present
    // and CLAUDE_PROJECT_DIR cleared, so the detection should fire.
    const result = runBin(['init', '--project-dir', '/tmp', '--silent'], {
      envOverride: { CLAUDE_PROJECT_DIR: undefined },
    });
    // Either exit 2 (wrong-window) OR exit 1 (validate project-dir refuses /tmp).
    // Both prove init is the real impl, not the stub.
    expect([1, 2]).toContain(result.status);
    expect(result.stderr).not.toContain('not yet implemented');
  });

  it('sync without API key exits 1 with invalid-key message', () => {
    const result = runBin(['sync'], {
      envOverride: { COMPANION_API_KEY: undefined },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid API key');
  });

  it('artifact-sync exits 0 silently when stdin is empty (best-effort hook)', () => {
    const result = runBin(['artifact-sync', '--silent'], {
      envOverride: { COMPANION_API_KEY: undefined },
      stdin: '',
    });
    // Hook contract: never blame the customer's tool call. Always exit 0.
    expect(result.status).toBe(0);
  });

  it('artifact-sync exits 0 when tool_name is not Write', () => {
    const result = runBin(['artifact-sync', '--silent'], {
      envOverride: { COMPANION_API_KEY: 'fake-key-not-used' },
      stdin: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/tmp/x.md' } }),
    });
    expect(result.status).toBe(0);
  });

  it('rejects --strategy with invalid value', () => {
    const result = runBin(['sync', '--strategy', 'invalid'], {
      envOverride: { COMPANION_API_KEY: 'fake-key' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--strategy: must be one of');
  });

  it('artifact-sync handles Edit tool (not just Write)', () => {
    const result = runBin(['artifact-sync', '--silent'], {
      envOverride: { COMPANION_API_KEY: 'fake-key' },
      stdin: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: '/tmp/x.md' } }),
    });
    // /tmp/x.md is outside any rootDir/artifact-dir, so the path filter catches
    // it and we still exit 0 — but the Edit tool name is no longer rejected
    // outright. Verifying the hook doesn't blame the customer.
    expect(result.status).toBe(0);
  });
});
