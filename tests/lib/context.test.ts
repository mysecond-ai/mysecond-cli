import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildContext, parseGlobalFlags, _legacyKeyWarningResetForTests } from '../../src/lib/context.js';
import { projectHash } from '../../src/lib/project-hash.js';

// Plant a project-scoped credentials file at the path getProjectScopedCredsPath
// would resolve to under an isolated $HOME. On macOS, getDeviceToken first
// probes the system keychain via `security`, but the account name is
// derived from projectHash(projectDir) — a tmp dir hash has effectively
// zero probability of colliding with a real keychain entry, so the probe
// returns null and the lookup falls through to this file.
function plantKeychainTokenForTest(home: string, projectDir: string, token: string): void {
  const credsDir = join(home, '.mysecond', 'projects', projectHash(projectDir));
  mkdirSync(credsDir, { recursive: true });
  const credsFile = join(credsDir, 'credentials');
  writeFileSync(credsFile, token, { encoding: 'utf-8', mode: 0o600 });
  chmodSync(credsFile, 0o600);
}

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

// v1.4.4 keychain-rescue — codex review #28 [P1] follow-up.
//
// The original v1.4.4 warning told customers with a legacy COMPANION_API_KEY
// to "re-authenticate", but after re-auth the env var still wins over the
// newly minted msd_ token in keychain, so they'd warn-and-re-auth on every
// run forever. Fix: when the env-supplied value is non-msd_ AND keychain
// has a valid msd_ token, prefer the keychain token and emit a distinct
// `keychain-rescue=true` marker so the customer knows to unset the env var.
//
// --api-key flag is an explicit override and is NEVER rescued — passing a
// legacy flag value means the user wants that value, even if it 401s.
describe('buildContext — v1.4.4 keychain rescue', () => {
  let savedKey: string | undefined;
  let savedHome: string | undefined;
  let savedClaudeDir: string | undefined;
  let stderrBuf: string;
  let origWrite: typeof process.stderr.write;

  function captureStderr(): void {
    origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = ((chunk: string | Uint8Array) => {
      stderrBuf += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    }) as typeof process.stderr.write;
  }

  beforeEach(() => {
    savedKey = process.env.COMPANION_API_KEY;
    savedHome = process.env.HOME;
    savedClaudeDir = process.env.CLAUDE_PROJECT_DIR;
    delete process.env.COMPANION_API_KEY;
    delete process.env.CLAUDE_PROJECT_DIR;
    stderrBuf = '';
    captureStderr();
    _legacyKeyWarningResetForTests();
  });

  afterEach(() => {
    process.stderr.write = origWrite;
    if (savedKey === undefined) delete process.env.COMPANION_API_KEY;
    else process.env.COMPANION_API_KEY = savedKey;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedClaudeDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = savedClaudeDir;
  });

  it('prefers keychain msd_ token over legacy COMPANION_API_KEY env value', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mysecond-ctx-'));
    process.env.HOME = tmp;
    process.env.COMPANION_API_KEY = 'companion_legacy_abc123';
    plantKeychainTokenForTest(tmp, tmp, 'msd_fresh_device_token_xyz');
    const ctx = buildContext(parseGlobalFlags(['--project-dir', tmp]));
    expect(ctx.apiKey).toBe('msd_fresh_device_token_xyz');
  });

  it('emits the keychain-rescue marker when rescuing a legacy env value', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mysecond-ctx-'));
    process.env.HOME = tmp;
    process.env.COMPANION_API_KEY = 'companion_legacy_abc123';
    plantKeychainTokenForTest(tmp, tmp, 'msd_fresh_device_token_xyz');
    buildContext(parseGlobalFlags(['--project-dir', tmp]));
    expect(stderrBuf).toContain('[mysecond:legacy-key-detected] source=env keychain-rescue=true');
    expect(stderrBuf).toContain('Unset COMPANION_API_KEY in your shell');
  });

  it('never echoes any portion of either token during rescue', () => {
    // The rescue path touches both the legacy env value and the rescued
    // msd_ token. Neither should appear in stderr.
    const tmp = mkdtempSync(join(tmpdir(), 'mysecond-ctx-'));
    process.env.HOME = tmp;
    process.env.COMPANION_API_KEY = 'companion_legacy_secret_envvalue';
    plantKeychainTokenForTest(tmp, tmp, 'msd_secret_keychain_value');
    buildContext(parseGlobalFlags(['--project-dir', tmp]));
    expect(stderrBuf).not.toContain('companion_legacy_secret_envvalue');
    expect(stderrBuf).not.toContain('msd_secret_keychain_value');
    expect(stderrBuf).not.toContain('secret');
  });

  it('does NOT rescue when --api-key flag supplies the legacy value (explicit override)', () => {
    // Flag is documented user override. If a customer passes
    // --api-key companion_legacy explicitly, they want that value used
    // even though keychain has a fresher msd_ token. Emit the original
    // warning (source=flag), not the rescue variant.
    const tmp = mkdtempSync(join(tmpdir(), 'mysecond-ctx-'));
    process.env.HOME = tmp;
    plantKeychainTokenForTest(tmp, tmp, 'msd_fresh_device_token_xyz');
    const ctx = buildContext(
      parseGlobalFlags(['--project-dir', tmp, '--api-key', 'companion_legacy_abc123'])
    );
    expect(ctx.apiKey).toBe('companion_legacy_abc123');
    expect(stderrBuf).toContain('[mysecond:legacy-key-detected] source=flag');
    expect(stderrBuf).not.toContain('keychain-rescue=true');
  });

  it('does NOT rescue when env value is already a valid msd_ token', () => {
    // An msd_-prefixed env value is legitimate (e.g., test fixture, CI).
    // Keep the env value, do not switch to keychain, emit nothing.
    const tmp = mkdtempSync(join(tmpdir(), 'mysecond-ctx-'));
    process.env.HOME = tmp;
    process.env.COMPANION_API_KEY = 'msd_env_token_abc';
    plantKeychainTokenForTest(tmp, tmp, 'msd_keychain_token_xyz');
    const ctx = buildContext(parseGlobalFlags(['--project-dir', tmp]));
    expect(ctx.apiKey).toBe('msd_env_token_abc');
    expect(stderrBuf).toBe('');
  });

  it('falls back to the original legacy-key warning when keychain has no token', () => {
    // No keychain entry → no rescue possible. Original v1.4.4 warning
    // fires with source=env (not keychain-rescue=true).
    const tmp = mkdtempSync(join(tmpdir(), 'mysecond-ctx-'));
    process.env.HOME = tmp;
    process.env.COMPANION_API_KEY = 'companion_legacy_abc123';
    const ctx = buildContext(parseGlobalFlags(['--project-dir', tmp]));
    expect(ctx.apiKey).toBe('companion_legacy_abc123');
    expect(stderrBuf).toContain('[mysecond:legacy-key-detected] source=env');
    expect(stderrBuf).not.toContain('keychain-rescue=true');
  });

  it('recovers paired COMPANION_API_URL from step-5b dotenv credentials during rescue', () => {
    // Staging customer installed pre-1.4.2 against a non-production host.
    // step-5b moved both COMPANION_API_KEY and COMPANION_API_URL out of
    // .env into the project-scoped credentials file. Their shell rc still
    // has the legacy COMPANION_API_KEY exported but NO COMPANION_API_URL.
    // Without recovering the URL during rescue, the freshly rescued msd_
    // token would be sent to https://app.mysecond.ai (production default)
    // and 401-loop. Codex pass-3 P2.
    const tmp = mkdtempSync(join(tmpdir(), 'mysecond-ctx-'));
    process.env.HOME = tmp;
    process.env.COMPANION_API_KEY = 'companion_legacy_abc123';
    delete process.env.COMPANION_API_URL; // ensure file fallback wins
    plantKeychainTokenForTest(
      tmp,
      tmp,
      'COMPANION_API_KEY=msd_staging_token_xyz\nCOMPANION_API_URL=https://staging.mysecond.ai\n'
    );
    const ctx = buildContext(parseGlobalFlags(['--project-dir', tmp]));
    expect(ctx.apiKey).toBe('msd_staging_token_xyz');
    expect(ctx.apiBase).toBe('https://staging.mysecond.ai');
  });

  it('shell COMPANION_API_URL wins over the rescued-from-keychain URL', () => {
    // Explicit shell env overrides should never be silently overridden
    // by stored credentials — a developer pointing at a local dev API
    // via `export COMPANION_API_URL=http://localhost:3000` expects that
    // to stick even if the keychain holds a staging URL.
    const tmp = mkdtempSync(join(tmpdir(), 'mysecond-ctx-'));
    process.env.HOME = tmp;
    process.env.COMPANION_API_KEY = 'companion_legacy_abc123';
    process.env.COMPANION_API_URL = 'http://localhost:3000';
    plantKeychainTokenForTest(
      tmp,
      tmp,
      'COMPANION_API_KEY=msd_staging_token_xyz\nCOMPANION_API_URL=https://staging.mysecond.ai\n'
    );
    const ctx = buildContext(parseGlobalFlags(['--project-dir', tmp]));
    expect(ctx.apiKey).toBe('msd_staging_token_xyz');
    expect(ctx.apiBase).toBe('http://localhost:3000');
  });

  it('rescues when the stored credential is in legacy step-5b dotenv format', () => {
    // step-5b writes `COMPANION_API_KEY=msd_xxx\nCOMPANION_API_URL=...` to
    // the SAME project-scoped path keychain.ts's fileGet reads. If
    // setDeviceToken never overwrote that file (first init aborted on
    // device-code prompt), the file-fallback rescue would have failed
    // because `startsWith('msd_')` doesn't match the dotenv envelope.
    // Codex P2 follow-up on PR #28 — normalize before the prefix check.
    const tmp = mkdtempSync(join(tmpdir(), 'mysecond-ctx-'));
    process.env.HOME = tmp;
    process.env.COMPANION_API_KEY = 'companion_legacy_abc123';
    plantKeychainTokenForTest(
      tmp,
      tmp,
      'COMPANION_API_KEY=msd_dotenv_format_xyz\nCOMPANION_API_URL=https://app.mysecond.ai\n'
    );
    const ctx = buildContext(parseGlobalFlags(['--project-dir', tmp]));
    expect(ctx.apiKey).toBe('msd_dotenv_format_xyz');
    expect(stderrBuf).toContain('[mysecond:legacy-key-detected] source=env keychain-rescue=true');
  });

  it('does NOT rescue when stored dotenv contents extract to a non-msd_ value', () => {
    // Belt-and-suspenders: a stored dotenv file that itself encodes a
    // legacy COMPANION_API_KEY (e.g., user upgraded step-5b but never
    // ran device-code) must NOT be treated as a rescue source — the
    // stored value is just as stale as the env var. Original
    // legacy-key warning fires, not the rescue variant.
    const tmp = mkdtempSync(join(tmpdir(), 'mysecond-ctx-'));
    process.env.HOME = tmp;
    process.env.COMPANION_API_KEY = 'companion_legacy_abc123';
    plantKeychainTokenForTest(
      tmp,
      tmp,
      'COMPANION_API_KEY=companion_legacy_stored\nCOMPANION_API_URL=https://app.mysecond.ai\n'
    );
    buildContext(parseGlobalFlags(['--project-dir', tmp]));
    expect(stderrBuf).toContain('[mysecond:legacy-key-detected] source=env');
    expect(stderrBuf).not.toContain('keychain-rescue=true');
  });

  it('rescue marker suppresses prose under --silent but emits the marker', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mysecond-ctx-'));
    process.env.HOME = tmp;
    process.env.COMPANION_API_KEY = 'companion_legacy_abc123';
    plantKeychainTokenForTest(tmp, tmp, 'msd_fresh_device_token_xyz');
    buildContext(parseGlobalFlags(['--project-dir', tmp, '--silent']));
    expect(stderrBuf).toContain('[mysecond:legacy-key-detected] source=env keychain-rescue=true');
    expect(stderrBuf).not.toContain('Unset COMPANION_API_KEY in your shell');
  });
});
