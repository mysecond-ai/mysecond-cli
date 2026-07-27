// Regression coverage for Item 2 — the doctor env-parser regression
// surfaced on 2026-05-25. step-5b writes dotenv-style credentials
// (`COMPANION_API_KEY=<token>\nCOMPANION_API_URL=<url>\n`) to the SAME
// project-scoped file that `setDeviceToken` writes bare tokens to. Before
// this fix, `getDeviceToken` returned the raw blob, so any caller that
// used `ReadResult.token` directly (notably `mysecond doctor`) pasted the
// literal "COMPANION_API_KEY=msd_..." string into the Bearer header and
// hit `Headers.append: invalid header value` from the embedded newline.
//
// Fix: normalize inside `getDeviceToken`. All callers get a clean token
// by default; the paired API URL is surfaced as a new optional field
// for the auth context (buildContext) that needs it.

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _normalizeStoredCredentialForTests as normalizeStoredCredential,
  getDeviceToken,
} from '../../src/lib/keychain.js';
import { projectHash } from '../../src/lib/project-hash.js';
import { installFakeHome, type FakeHome } from '../helpers/fake-home.js';

/**
 * Plant a project-scoped credentials file under an isolated $HOME so
 * `getDeviceToken`'s file-fallback path picks it up. Mirrors the helper
 * already used in `tests/lib/context.test.ts`.
 */
function plantCredsFile(home: string, projectDir: string, content: string): string {
  const credsDir = join(home, '.mysecond', 'projects', projectHash(projectDir));
  mkdirSync(credsDir, { recursive: true });
  const credsFile = join(credsDir, 'credentials');
  writeFileSync(credsFile, content, { encoding: 'utf-8', mode: 0o600 });
  chmodSync(credsFile, 0o600);
  return credsFile;
}

describe('getDeviceToken — normalizes stored credential format', () => {
  // installFakeHome sets BOTH HOME and USERPROFILE — os.homedir() reads
  // USERPROFILE on win32, so a HOME-only sandbox planted fixtures in the
  // real runner home there.
  let fake: FakeHome;

  beforeEach(() => {
    fake = installFakeHome('mysecond-kc-');
    // MYSECOND_NO_KEYCHAIN=1 forces the file-fallback path so the test is
    // deterministic across darwin (system keychain) and linux/CI.
    process.env.MYSECOND_NO_KEYCHAIN = '1';
  });

  afterEach(() => {
    fake.restore();
    delete process.env.MYSECOND_NO_KEYCHAIN;
  });

  it('returns the bare token when credentials file is bare-token format', () => {
    const project = mkdtempSync(join(tmpdir(), 'mysecond-kc-proj-'));
    plantCredsFile(fake.home, project, 'msd_bare_token_abc\n');

    const result = getDeviceToken(project);
    expect(result).not.toBeNull();
    expect(result!.token).toBe('msd_bare_token_abc');
    expect(result!.storage).toBe('file_fallback');
    expect(result!.apiUrl).toBeNull();
  });

  it('strips the dotenv wrapper when step-5b wrote dotenv-style content', () => {
    // This is the regression case. Before the fix, .token contained the
    // literal "COMPANION_API_KEY=msd_...\nCOMPANION_API_URL=..." blob.
    const project = mkdtempSync(join(tmpdir(), 'mysecond-kc-proj-'));
    plantCredsFile(
      fake.home,
      project,
      'COMPANION_API_KEY=msd_dotenv_token_xyz\nCOMPANION_API_URL=https://staging.mysecond.ai\n'
    );

    const result = getDeviceToken(project);
    expect(result).not.toBeNull();
    expect(result!.token).toBe('msd_dotenv_token_xyz');
    expect(result!.token).not.toContain('\n');
    expect(result!.token).not.toContain('COMPANION_API_KEY=');
    expect(result!.token).not.toContain('COMPANION_API_URL=');
    expect(result!.apiUrl).toBe('https://staging.mysecond.ai');
  });

  it('handles dotenv format with COMPANION_API_KEY only (no URL line)', () => {
    const project = mkdtempSync(join(tmpdir(), 'mysecond-kc-proj-'));
    plantCredsFile(fake.home, project, 'COMPANION_API_KEY=msd_only_key\n');

    const result = getDeviceToken(project);
    expect(result).not.toBeNull();
    expect(result!.token).toBe('msd_only_key');
    expect(result!.apiUrl).toBeNull();
  });

  it('returns null when no credentials file exists', () => {
    const project = mkdtempSync(join(tmpdir(), 'mysecond-kc-proj-'));

    expect(getDeviceToken(project)).toBeNull();
  });

  it('produces a token safe to use as a Bearer header value (regression-proof)', () => {
    // Direct guard for the Item 2 failure mode: Headers.append rejects any
    // value containing CR/LF. If a future caller pastes ReadResult.token
    // into a header again, this test ensures the value is well-formed.
    const project = mkdtempSync(join(tmpdir(), 'mysecond-kc-proj-'));
    plantCredsFile(
      fake.home,
      project,
      'COMPANION_API_KEY=msd_token\nCOMPANION_API_URL=https://app.mysecond.ai\n'
    );

    const result = getDeviceToken(project);
    expect(result).not.toBeNull();

    // The actual platform check that was failing: `new Headers()` throws on
    // values containing newlines or other control characters.
    expect(() => {
      new Headers({ authorization: `Bearer ${result!.token}` });
    }).not.toThrow();
  });
});

// Direct unit coverage for the normalizer. Exercises inputs that the
// `fileGet`/`macosKeychainGet` pipelines pre-trim in practice, but the
// normalizer should defend against on its own — review feedback (codex
// review pass, 2026-05-25): callers should not be load-bearing for
// header-safety.
describe('normalizeStoredCredential — direct, no filesystem', () => {
  it('strips a trailing newline from a bare token (defense in depth)', () => {
    // Real callers trim before passing in, but the normalizer should be
    // safe even if a future input source (libsecret, Win cred mgr)
    // doesn't.
    expect(normalizeStoredCredential('msd_token_xyz\n')).toEqual({
      token: 'msd_token_xyz',
      apiUrl: null,
    });
  });

  it('strips CRLF from a bare token', () => {
    expect(normalizeStoredCredential('msd_token_crlf\r\n')).toEqual({
      token: 'msd_token_crlf',
      apiUrl: null,
    });
  });

  it('extracts token + apiUrl from CRLF-encoded step-5b dotenv', () => {
    // Windows-mounted volumes or hand-edited files can carry CRLF.
    const result = normalizeStoredCredential(
      'COMPANION_API_KEY=msd_crlf_token\r\nCOMPANION_API_URL=https://staging.mysecond.ai\r\n'
    );
    expect(result.token).toBe('msd_crlf_token');
    expect(result.apiUrl).toBe('https://staging.mysecond.ai');
  });

  it('rejects empty-value COMPANION_API_KEY= (malformed step-5b output)', () => {
    // If step-5b ever wrote an empty key value, the regex misses (`.+`
    // requires ≥1 char) and the normalizer must NOT fall through to
    // returning the raw multi-line blob. Empty token signals "no
    // credential" to the caller.
    const result = normalizeStoredCredential(
      'COMPANION_API_KEY=\nCOMPANION_API_URL=https://app.mysecond.ai\n'
    );
    expect(result.token).toBe('');
  });

  it('rejects `export `-prefixed COMPANION_API_KEY (unsupported variant)', () => {
    // Our regex anchors at column 0 with no `export ` tolerance — that
    // matches step-5b's exact write format. An export-prefixed file is
    // rejected (empty token) rather than silently returned with the
    // wrapper as the token.
    const result = normalizeStoredCredential(
      'export COMPANION_API_KEY=msd_x\nCOMPANION_API_URL=https://app.mysecond.ai\n'
    );
    expect(result.token).toBe('');
  });

  it('rejects spaces-around-equals (unsupported variant)', () => {
    const result = normalizeStoredCredential('COMPANION_API_KEY = msd_x\n');
    expect(result.token).toBe('');
  });

  it('rejects any structured input whose token would contain a newline', () => {
    // Belt-and-suspenders: even if a future regex change matched a
    // value that happened to contain a CR/LF, the final post-check
    // forces an empty token.
    const result = normalizeStoredCredential('plain\nmultiline\nwithout\ndotenv\nmarkers');
    expect(result.token).toBe('');
  });

  it('every direct output is safe in Headers.append (sweep)', () => {
    const inputs = [
      'msd_bare',
      'msd_with_trailing_lf\n',
      'msd_with_crlf\r\n',
      'COMPANION_API_KEY=msd_dotenv\nCOMPANION_API_URL=https://app.mysecond.ai\n',
      'COMPANION_API_KEY=msd_dotenv_crlf\r\nCOMPANION_API_URL=https://app.mysecond.ai\r\n',
      'COMPANION_API_KEY=\nCOMPANION_API_URL=https://app.mysecond.ai\n',
      'export COMPANION_API_KEY=msd_x\n',
      '',
    ];
    for (const raw of inputs) {
      const { token } = normalizeStoredCredential(raw);
      // Empty token is fine — getDeviceToken converts to null. Non-empty
      // tokens MUST be safe in a Bearer header.
      if (token.length > 0) {
        expect(() => new Headers({ authorization: `Bearer ${token}` })).not.toThrow();
      }
    }
  });
});
