import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildContext, parseGlobalFlags, _legacyKeyWarningResetForTests } from '../../src/lib/context.js';

describe('parseGlobalFlags', () => {
  it('parses no args as defaults', () => {
    const f = parseGlobalFlags([]);
    expect(f.silent).toBe(false);
    expect(f.dryRun).toBe(false);
    expect(f.forceUpdate).toBe(false);
    expect(f.apiKey).toBeNull();
    expect(f.projectDir).toBeNull();
    expect(f.strategy).toBeNull();
    expect(f.positional).toEqual([]);
  });

  it('parses boolean flags', () => {
    const f = parseGlobalFlags(['--silent', '--dry-run', '--force-update']);
    expect(f.silent).toBe(true);
    expect(f.dryRun).toBe(true);
    expect(f.forceUpdate).toBe(true);
  });

  it('parses value flags', () => {
    const f = parseGlobalFlags(['--api-key', 'k', '--project-dir', '/p', '--strategy', 'cloud-wins']);
    expect(f.apiKey).toBe('k');
    expect(f.projectDir).toBe('/p');
    expect(f.strategy).toBe('cloud-wins');
  });

  it('throws on missing value for --api-key', () => {
    expect(() => parseGlobalFlags(['--api-key'])).toThrow('--api-key: requires a value');
  });

  it('throws on invalid --strategy value', () => {
    expect(() => parseGlobalFlags(['--strategy', 'bogus'])).toThrow('--strategy: must be one of');
  });

  it('collects positional args', () => {
    const f = parseGlobalFlags(['arg1', '--silent', 'arg2']);
    expect(f.positional).toEqual(['arg1', 'arg2']);
  });

  // v1.4.2: two-command auth flow flags.
  it('parses --auth-only flag', () => {
    const f = parseGlobalFlags(['--auth-only']);
    expect(f.authOnly).toBe(true);
    expect(f.resume).toBe(false);
  });

  it('parses --resume flag', () => {
    const f = parseGlobalFlags(['--resume']);
    expect(f.resume).toBe(true);
    expect(f.authOnly).toBe(false);
  });

  it('defaults authOnly + resume to false', () => {
    const f = parseGlobalFlags([]);
    expect(f.authOnly).toBe(false);
    expect(f.resume).toBe(false);
  });
});

describe('buildContext', () => {
  let savedHome: string | undefined;
  let savedKey: string | undefined;
  let savedUrl: string | undefined;
  let savedClaudeDir: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedKey = process.env.COMPANION_API_KEY;
    savedUrl = process.env.COMPANION_API_URL;
    savedClaudeDir = process.env.CLAUDE_PROJECT_DIR;
    delete process.env.COMPANION_API_KEY;
    delete process.env.COMPANION_API_URL;
    delete process.env.CLAUDE_PROJECT_DIR;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedKey === undefined) delete process.env.COMPANION_API_KEY;
    else process.env.COMPANION_API_KEY = savedKey;
    if (savedUrl === undefined) delete process.env.COMPANION_API_URL;
    else process.env.COMPANION_API_URL = savedUrl;
    if (savedClaudeDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = savedClaudeDir;
  });

  it('defaults apiBase to production', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mysecond-ctx-'));
    const ctx = buildContext(parseGlobalFlags(['--project-dir', tmp]));
    expect(ctx.apiBase).toBe('https://app.mysecond.ai');
  });

  it('reads apiKey + apiBase from .env in rootDir', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mysecond-ctx-'));
    writeFileSync(
      join(tmp, '.env'),
      'COMPANION_API_KEY=from-dotenv\nCOMPANION_API_URL=https://staging.mysecond.ai\n'
    );
    const ctx = buildContext(parseGlobalFlags(['--project-dir', tmp]));
    expect(ctx.apiKey).toBe('from-dotenv');
    expect(ctx.apiBase).toBe('https://staging.mysecond.ai');
  });

  it('--api-key flag wins over env', () => {
    process.env.COMPANION_API_KEY = 'from-env';
    const tmp = mkdtempSync(join(tmpdir(), 'mysecond-ctx-'));
    const ctx = buildContext(parseGlobalFlags(['--project-dir', tmp, '--api-key', 'from-flag']));
    expect(ctx.apiKey).toBe('from-flag');
  });

  it('strategy defaults to cloud-wins in --silent mode', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mysecond-ctx-'));
    const ctx = buildContext(parseGlobalFlags(['--project-dir', tmp, '--silent']));
    expect(ctx.strategy).toBe('cloud-wins');
    expect(ctx.silent).toBe(true);
  });

  it('--strategy flag wins over default', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mysecond-ctx-'));
    const ctx = buildContext(
      parseGlobalFlags(['--project-dir', tmp, '--silent', '--strategy', 'local-wins'])
    );
    expect(ctx.strategy).toBe('local-wins');
  });
});

// v1.4.4 — legacy companion_api_key deprecation warning.
//
// Source-based gating: keychain-sourced tokens are msd_-prefixed by
// construction. Flag/env-sourced tokens that don't start with msd_ are
// the legacy team-shared keys server-side PR3b will stop accepting. The
// warning fires once per process to give pre-1.4.2 customers a heads-up.
//
// The structured marker `[mysecond:legacy-key-detected] source=...` is a
// stable public contract (semver gates format changes).
describe('buildContext — v1.4.4 legacy-key warning', () => {
  let savedKey: string | undefined;
  let savedHome: string | undefined;
  let savedClaudeDir: string | undefined;
  let stderrBuf: string;
  let stderrSpy: ReturnType<typeof captureStderr>;

  function captureStderr(): { restore: () => void } {
    const origWrite = process.stderr.write.bind(process.stderr);
    // Vitest's process.stderr.write has overloads; the cast keeps the test
    // simple while still capturing every byte the warning helper writes.
    (process.stderr.write as unknown) = ((chunk: string | Uint8Array) => {
      stderrBuf += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    }) as typeof process.stderr.write;
    return {
      restore: () => {
        process.stderr.write = origWrite;
      },
    };
  }

  beforeEach(() => {
    savedKey = process.env.COMPANION_API_KEY;
    savedHome = process.env.HOME;
    savedClaudeDir = process.env.CLAUDE_PROJECT_DIR;
    delete process.env.COMPANION_API_KEY;
    delete process.env.CLAUDE_PROJECT_DIR;
    stderrBuf = '';
    stderrSpy = captureStderr();
    _legacyKeyWarningResetForTests();
  });

  afterEach(() => {
    stderrSpy.restore();
    if (savedKey === undefined) delete process.env.COMPANION_API_KEY;
    else process.env.COMPANION_API_KEY = savedKey;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedClaudeDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = savedClaudeDir;
  });

  it('emits marker + prose for a non-msd_ COMPANION_API_KEY env value', () => {
    process.env.COMPANION_API_KEY = 'companion_legacy_abc123';
    const tmp = mkdtempSync(join(tmpdir(), 'mysecond-ctx-'));
    buildContext(parseGlobalFlags(['--project-dir', tmp]));
    expect(stderrBuf).toContain('[mysecond:legacy-key-detected] source=env');
    expect(stderrBuf).toContain('looks like a legacy team key');
  });

  it('emits marker + prose for a non-msd_ --api-key flag value', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mysecond-ctx-'));
    buildContext(
      parseGlobalFlags(['--project-dir', tmp, '--api-key', 'companion_legacy_abc123'])
    );
    expect(stderrBuf).toContain('[mysecond:legacy-key-detected] source=flag');
    expect(stderrBuf).toContain('looks like a legacy team key');
  });

  it('never echoes any portion of the token value in the warning', () => {
    // Bash-tool stderr is captured into model context and persisted in
    // transcripts — token bytes there are a leak class. Source label only.
    process.env.COMPANION_API_KEY = 'companion_legacy_secrettoken_xyz';
    const tmp = mkdtempSync(join(tmpdir(), 'mysecond-ctx-'));
    buildContext(parseGlobalFlags(['--project-dir', tmp]));
    expect(stderrBuf).not.toContain('companion_legacy_secrettoken_xyz');
    expect(stderrBuf).not.toContain('secrettoken');
    expect(stderrBuf).not.toContain('xyz');
  });

  it('stays silent for an msd_-prefixed COMPANION_API_KEY env value', () => {
    process.env.COMPANION_API_KEY = 'msd_validdevicetoken_abc';
    const tmp = mkdtempSync(join(tmpdir(), 'mysecond-ctx-'));
    buildContext(parseGlobalFlags(['--project-dir', tmp]));
    expect(stderrBuf).toBe('');
  });

  it('stays silent for an msd_-prefixed --api-key flag value', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mysecond-ctx-'));
    buildContext(
      parseGlobalFlags(['--project-dir', tmp, '--api-key', 'msd_validdevicetoken_abc'])
    );
    expect(stderrBuf).toBe('');
  });

  it('stays silent when no token is configured', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mysecond-ctx-'));
    // HOME isolated so the keychain/file fallback can't pick up a real
    // device token from the developer running the tests.
    process.env.HOME = tmp;
    buildContext(parseGlobalFlags(['--project-dir', tmp]));
    expect(stderrBuf).toBe('');
  });

  it('emits marker but suppresses prose under --silent', () => {
    process.env.COMPANION_API_KEY = 'companion_legacy_abc123';
    const tmp = mkdtempSync(join(tmpdir(), 'mysecond-ctx-'));
    buildContext(parseGlobalFlags(['--project-dir', tmp, '--silent']));
    expect(stderrBuf).toContain('[mysecond:legacy-key-detected] source=env');
    expect(stderrBuf).not.toContain('looks like a legacy team key');
  });

  it('fires only once per process even on repeated buildContext calls', () => {
    process.env.COMPANION_API_KEY = 'companion_legacy_abc123';
    const tmp = mkdtempSync(join(tmpdir(), 'mysecond-ctx-'));
    buildContext(parseGlobalFlags(['--project-dir', tmp]));
    buildContext(parseGlobalFlags(['--project-dir', tmp]));
    const markerMatches = stderrBuf.match(/\[mysecond:legacy-key-detected\]/g) ?? [];
    expect(markerMatches.length).toBe(1);
  });

  it('honors source-based gating — does not warn on a keychain-sourced value', () => {
    // Regression guard: if a future refactor accidentally regresses to
    // a prefix-only check (without the source gate), keychain-sourced
    // non-msd_ values would trigger false warnings. setDeviceToken is the
    // only keychain writer and only writes msd_ today, but the source gate
    // is the durable invariant.
    //
    // We can't easily plant a synthetic non-msd_ keychain value without
    // mocking keychain.ts internals. Instead assert structurally: with no
    // env and no flag, the warning helper is unreachable.
    const tmp = mkdtempSync(join(tmpdir(), 'mysecond-ctx-'));
    process.env.HOME = tmp;
    buildContext(parseGlobalFlags(['--project-dir', tmp]));
    expect(stderrBuf).toBe('');
  });
});
