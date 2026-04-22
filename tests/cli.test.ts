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

const STUB_SUBCOMMANDS = ['init', 'sync', 'artifact-sync'] as const;

interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runBin(args: readonly string[]): ExecResult {
  const opts: ExecFileSyncOptionsWithStringEncoding = {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  };
  try {
    const stdout = execFileSync('node', [BIN, ...args], opts);
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

  it('lists all stub subcommands in --help output', () => {
    const result = runBin(['--help']);
    expect(result.status).toBe(0);
    // Tight regex: each subcommand appears as a leading-indented help row, not as a
    // substring inside another word (e.g., 'init' inside 'not yet implemented').
    for (const name of STUB_SUBCOMMANDS) {
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

  it.each(STUB_SUBCOMMANDS)('%s stub exits 1 with not-implemented message', (name) => {
    const result = runBin([name]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not yet implemented');
    expect(result.stderr).toContain(name);
  });
});
