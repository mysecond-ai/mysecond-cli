// Step 1: Validate --project-dir + Node version + Claude Code version pre-check.
// Fails fast (no writes, no network). Always re-runs (cheap).

import { spawnSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';

import { MysecondError } from '../errors.js';
import { isForbiddenProjectDir } from '../mysecond-paths.js';

import type { StepFn } from './types.js';

const MIN_NODE_MAJOR = 18;

// CAIO Y-CC-Floor (EDD v1.5 §4.3 + §6.2) — mysecond init relies on
// `claude plugin marketplace add` + `claude plugin install` which require this
// minimum Claude Code version. Older versions emit "unknown command: marketplace"
// which leads to a confusing customer-facing error during step 9. Pin explicitly
// here so we fail early with an actionable message instead of mid-install.
export const MIN_CLAUDE_CODE_VERSION = '2.1.118';

export function parseNodeMajor(version: string): number | null {
  // process.versions.node looks like "20.11.1" — no leading "v".
  const match = /^(\d+)\./.exec(version);
  if (match === null || match[1] === undefined) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a Claude Code version string into a comparable `[major, minor, patch]` tuple.
 *
 * Handles observed output shapes of `claude --version`:
 *   - "2.1.118"
 *   - "2.1.118 (Claude Code)"
 *   - "Claude Code 2.1.118"
 *   - "claude 2.1.118"
 */
export function parseClaudeVersion(raw: string): [number, number, number] | null {
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(raw);
  if (!match || !match[1] || !match[2] || !match[3]) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null;
  }
  return [major, minor, patch];
}

export function compareVersions(
  a: [number, number, number],
  b: [number, number, number]
): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

export type ClaudeProbeResult =
  | { kind: 'ok'; version: [number, number, number]; raw: string }
  | { kind: 'not_detected' }
  | { kind: 'unparseable'; raw: string };

export type ClaudeVersionProbe = () => ClaudeProbeResult;

/**
 * Default probe — spawns `claude --version` with a 5s timeout. Returns
 * `not_detected` on ENOENT / non-zero exit / spawn error; `unparseable` when
 * output exists but no semver triple is present. Split out from step1 so
 * tests can inject a fake probe without needing a real claude binary.
 */
export const defaultClaudeVersionProbe: ClaudeVersionProbe = () => {
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync('claude', ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return { kind: 'not_detected' };
  }

  if (result.error || result.status === null || result.status !== 0) {
    return { kind: 'not_detected' };
  }

  const raw = (result.stdout ?? '').toString().trim();
  const parsed = parseClaudeVersion(raw);
  if (!parsed) {
    return { kind: 'unparseable', raw };
  }
  return { kind: 'ok', version: parsed, raw };
};

// Test seam — swap the probe without touching step1's StepFn signature.
// Tests call `__setClaudeVersionProbe(fakeProbe)` in beforeEach, then
// `__resetClaudeVersionProbe()` in afterEach.
let activeProbe: ClaudeVersionProbe = defaultClaudeVersionProbe;
export function __setClaudeVersionProbe(probe: ClaudeVersionProbe): void {
  activeProbe = probe;
}
export function __resetClaudeVersionProbe(): void {
  activeProbe = defaultClaudeVersionProbe;
}

export const step1: StepFn = async ({ ctx }) => {
  // ── Node version check ────────────────────────────────────────────────────
  const major = parseNodeMajor(process.versions.node);
  if (major === null || major < MIN_NODE_MAJOR) {
    // CTO-6 / HoD-4b: exit BEFORE any network/IO. bin/mysecond.cjs has its own
    // shebang guard but PATH oddities (nvm + system node) can route around it,
    // so we re-check here.
    throw MysecondError.nodeTooOld(process.versions.node);
  }

  // ── --project-dir safety check ────────────────────────────────────────────
  const root = isAbsolute(ctx.rootDir) ? ctx.rootDir : resolve(process.cwd(), ctx.rootDir);
  if (isForbiddenProjectDir(root)) {
    throw MysecondError.localStateConflict(
      `--project-dir=${root} refused (path traversal / system dir guard)`
    );
  }

  // ── Claude Code version floor (CAIO Y-CC-Floor) ──────────────────────────
  const probed = activeProbe();

  switch (probed.kind) {
    case 'ok': {
      const required = parseClaudeVersion(MIN_CLAUDE_CODE_VERSION);
      if (!required) {
        // Dev-time assertion — MIN_CLAUDE_CODE_VERSION is a constant we control.
        throw new Error(
          `MIN_CLAUDE_CODE_VERSION='${MIN_CLAUDE_CODE_VERSION}' failed to parse. Build broken.`
        );
      }
      if (compareVersions(probed.version, required) < 0) {
        throw MysecondError.claudeCodeTooOld(probed.raw, MIN_CLAUDE_CODE_VERSION);
      }
      break;
    }
    case 'not_detected':
      throw MysecondError.claudeCodeNotDetected();
    case 'unparseable':
      // Conservative: unparseable output (e.g., a future Claude Code release
      // changes the version format) shouldn't block install. If the actual
      // marketplace command fails later, step 9's telemetry surfaces it.
      break;
  }

  return { step: 1, outcome: { kind: 'completed' } };
};
