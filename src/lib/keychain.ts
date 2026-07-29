// Keychain — OS-aware token storage for Workstream B (Phase 2a).
//
// macOS: `security add-generic-password` / `security find-generic-password`.
// Linux / CI / Docker / Windows: file fallback at the existing
// project-scoped credentials path (mode 0600) with a stderr warning on
// the first fallback per session.
//
// Locked decisions per the brief:
//   - No `keytar` (native build deps fragile across Node versions and
//     CI environments). 2a uses `security` shell-out only.
//   - Windows is file-fallback at 2a; native Windows Credential Manager
//     lands in Phase 2b.
//
// CTO Day 1 stop condition (round-trip): every keychain write is followed
// by an immediate read on the same call pattern. Sandboxed macOS environments
// occasionally accept writes silently and reject reads — we fail closed and
// fall back to file before a write that "looked like it worked" rots a
// subsequent `sync`.
//
// Brief: ~/.claude/plans/workstream-b-device-code-brief.md

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

import { atomicWriteFile } from './atomic-write.js';
import {
  getGlobalCredsPath,
  getProjectScopedCredsPath,
  getProjectScopedCredsDir,
} from './creds-path.js';
import { mkdirSync } from 'node:fs';
import { projectHash } from './project-hash.js';

/**
 * Where the token came from on a successful read.
 *
 * `global_file` (v1.12.0) is READ-only: `getDeviceToken` reports it when the
 * machine-wide `~/.mysecond/credentials` fallback resolved the token, but
 * `setDeviceToken` never writes there — project-scoped keychain/file remain
 * the only write targets.
 */
export type TokenStorage = 'keychain' | 'file_fallback' | 'global_file';

export interface ReadResult {
  /** Normalized bare token, safe to paste into a Bearer header. */
  token: string;
  storage: TokenStorage;
  /**
   * Paired `COMPANION_API_URL` when the stored credential was written by
   * step-5b in dotenv format. `null` for bare-token stores (the v1.4.0+
   * path written by `setDeviceToken`). Surfaced so `buildContext` can
   * recover the URL during legacy-credential rescue without re-parsing.
   */
  apiUrl: string | null;
}

/**
 * Two formats live at the same project-scoped credentials path:
 *   1. Bare token — `setDeviceToken` writes `<token>\n` (v1.4.0+ canonical).
 *   2. step-5b exact dotenv format —
 *      `COMPANION_API_KEY=<token>\nCOMPANION_API_URL=<url>\n` (legacy /
 *      installed-base recovery path). step-5b writes this exact shape;
 *      we do not aspire to be a general dotenv parser.
 *
 * Item 2 (2026-05-25): `getDeviceToken` previously returned the raw blob.
 * Callers that pasted `ReadResult.token` into a Bearer header (notably
 * `mysecond doctor`) hit `Headers.append: invalid header value` because of
 * the embedded newline. Normalization now happens inside `getDeviceToken`
 * so every caller is regression-proof by construction.
 *
 * Hardening (post-review, 2026-05-25):
 *   - Always trim the returned token. `fileGet`/`macosKeychainGet` both
 *     trim their output today, but the normalizer should not depend on
 *     that — a future input source (libsecret, Windows credential mgr)
 *     might not.
 *   - If input looks structured (contains `\n` or `=`) but no
 *     `COMPANION_API_KEY=` line matches, treat as unparseable and return
 *     an empty token. The caller (`getDeviceToken`) converts that to
 *     `null`, so downstream sees "no credential" rather than a malformed
 *     bearer. This catches: empty-value `COMPANION_API_KEY=` lines,
 *     `export`-prefixed keys, spaces around `=`, and any future drift in
 *     step-5b's write format.
 *   - Final post-check: if the returned token still contains any
 *     control char that `Headers.append` rejects (CR/LF), reject it.
 *     Defense in depth.
 *
 * Exported as `_normalizeStoredCredentialForTests` so the unit suite can
 * cover CRLF and malformed-format inputs without filesystem fixtures.
 */
export function _normalizeStoredCredentialForTests(
  raw: string
): { token: string; apiUrl: string | null } {
  return normalizeStoredCredential(raw);
}

function normalizeStoredCredential(raw: string): { token: string; apiUrl: string | null } {
  // Bare-token shortcut: trim leading/trailing whitespace (including CR,
  // LF, tabs) and check whether anything structured remains. The
  // canonical `setDeviceToken` write format is `<token>\n` — after trim
  // that becomes a clean bare token.
  const trimmed = raw.trim();
  if (!trimmed.includes('\n') && !trimmed.includes('=')) {
    return { token: containsCtl(trimmed) ? '' : trimmed, apiUrl: null };
  }

  // step-5b exact format: `^COMPANION_API_KEY=<value>$` at column 0.
  // `.+` requires at least one character so empty-value lines miss the
  // match and fall through to the "unparseable structured input" branch
  // below — safer than returning an empty token tied to a recovered URL.
  let apiUrl: string | null = null;
  const tokenMatch = raw.match(/^COMPANION_API_KEY=(.+)$/m);
  const urlMatch = raw.match(/^COMPANION_API_URL=(.+)$/m);
  if (urlMatch !== null && urlMatch[1] !== undefined) {
    apiUrl = urlMatch[1].trim();
  }

  if (tokenMatch !== null && tokenMatch[1] !== undefined) {
    const token = tokenMatch[1].trim();
    return { token: containsCtl(token) ? '' : token, apiUrl };
  }

  // Structured input (has `\n` or `=` after trim) but no
  // `COMPANION_API_KEY=` match. Reject the entire credential — returning
  // the raw blob would put a multi-line string into someone's Bearer
  // header. Caller treats empty token as "no credential found" and
  // prompts re-auth.
  return { token: '', apiUrl: null };
}

/** True if `s` contains any character that `Headers.append` would reject. */
function containsCtl(s: string): boolean {
  // Headers.append rejects CR, LF, NUL, and anything outside ISO-8859-1.
  // We only need to guard the cases the credential store has ever
  // produced — CR/LF — but checking the full set is cheap.
  return /[\r\n\0]/.test(s);
}

/**
 * Reason a file fallback was used. Surfaced into PostHog event
 * `mysecond.cli.install_completed.keychain_unavailable_reason`.
 */
export type FallbackReason =
  | 'no_keychain' // platform without a usable keychain
  | 'libsecret_unavailable'
  | 'linux_headless'
  | 'env_disabled' // MYSECOND_NO_KEYCHAIN=1
  | 'roundtrip_failed' // wrote to keychain but couldn't read back
  | 'write_failed'; // shell-out itself errored

const SERVICE_NAME = 'ai.mysecond.cli';
let warnedThisSession = false;

function platformSupportsKeychain(): { supported: boolean; reason?: FallbackReason } {
  if (process.env.MYSECOND_NO_KEYCHAIN === '1') {
    return { supported: false, reason: 'env_disabled' };
  }
  if (process.platform === 'darwin') return { supported: true };
  if (process.platform === 'linux') {
    // libsecret integration deferred to Phase 2b — file fallback today.
    return { supported: false, reason: 'libsecret_unavailable' };
  }
  if (process.platform === 'win32') {
    // Windows Credential Manager deferred to Phase 2b (locked decision).
    return { supported: false, reason: 'no_keychain' };
  }
  return { supported: false, reason: 'no_keychain' };
}

function emitFallbackWarningOnce(reason: FallbackReason, filePath: string): void {
  if (warnedThisSession) return;
  warnedThisSession = true;
  process.stderr.write(
    `mysecond: storing credential in file (${reason}). Path: ${filePath} (mode 0600). ` +
      'On macOS, set MYSECOND_NO_KEYCHAIN=1 to opt out of keychain explicitly.\n'
  );
}

function accountFor(absoluteProjectDir: string): string {
  // One keychain entry per project so multiple projects on the same machine
  // can each hold their own device token. Hash via the same project-hash
  // function the rest of the cli uses for path scoping.
  // project-hash is imported at module top — was previously a dynamic
  // require() to keep the import graph minimal, but vitest's TS loader
  // can't resolve dynamic requires with `.js` extensions inside `.ts`
  // sources, so unit tests that exercise getDeviceToken/setDeviceToken
  // would throw MODULE_NOT_FOUND. The top-level import has effectively
  // zero startup cost (project-hash only imports node:crypto, which is
  // already loaded by every other code path that hits this file).
  return `device-token-${projectHash(absoluteProjectDir)}`;
}

// ── macOS keychain via `security` shell-out ────────────────────────────────

function macosKeychainSet(account: string, token: string): void {
  // -U updates if entry exists. -w with NO value reads the password from stdin
  // (NOT as a positional arg) — this is the load-bearing security choice.
  // Passing the token as a CLI arg ("-w <token>") leaks it via `ps aux` for
  // the ~50-200ms duration of the security binary execution. CISO Day-2/3
  // interim review (P1, blocks Day 4): use stdin so the token never appears
  // in the process listing.
  // -s sets the service name (filterable in Keychain Access). -a sets account.
  execFileSync(
    'security',
    ['add-generic-password', '-U', '-s', SERVICE_NAME, '-a', account, '-w'],
    {
      input: token,
      stdio: ['pipe', 'ignore', 'pipe'],
    }
  );
}

function macosKeychainGet(account: string): string | null {
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-s', SERVICE_NAME, '-a', account, '-w'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const value = out.toString('utf8').trim();
    return value.length > 0 ? value : null;
  } catch {
    // Not found OR access denied (sandbox). Treat both as "missing" — the
    // caller will fall back to file storage if write also fails round-trip.
    return null;
  }
}

function macosKeychainDelete(account: string): void {
  try {
    execFileSync(
      'security',
      ['delete-generic-password', '-s', SERVICE_NAME, '-a', account],
      { stdio: 'ignore' }
    );
  } catch {
    // No-op if not present.
  }
}

// ── File fallback (existing project-scoped creds path) ─────────────────────

function fileSet(absoluteProjectDir: string, token: string): void {
  const dir = getProjectScopedCredsDir(absoluteProjectDir);
  mkdirSync(dir, { recursive: true });
  const filePath = getProjectScopedCredsPath(absoluteProjectDir);
  atomicWriteFile(filePath, token + '\n', { mode: 0o600 });
  // atomicWriteFile uses rename which preserves mode, but harden anyway —
  // a pre-existing file with broader perms could survive the rename on
  // some filesystems.
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // best-effort; the atomic write already passed
  }
}

function fileGet(absoluteProjectDir: string): string | null {
  const filePath = getProjectScopedCredsPath(absoluteProjectDir);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf8').trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

function fileDelete(absoluteProjectDir: string): void {
  const filePath = getProjectScopedCredsPath(absoluteProjectDir);
  try {
    unlinkSync(filePath);
  } catch {
    // No-op if not present.
  }
}

// ── Global file fallback (~/.mysecond/credentials) ─────────────────────────
//
// Written by the public plugin's `/mysecond` login skill (mysecond-ai/pm-os,
// skills/mysecond/SKILL.md): dotenv form `COMPANION_API_KEY=<token>\n`,
// mode 0600, machine-wide (NOT project-hashed). Before v1.12.0 this path
// appeared only in `whereami`'s precedence DISPLAY — the resolver never read
// it, so a post-`/mysecond` login left every plugin sync hook (`sync`,
// `artifact-sync`, `emit-event`, push sweep) unauthenticated: the silent
// "installed but never phoned home" failure. Read-only here; the CLI never
// writes, chmods, or deletes this file.

function globalFileGet(): string | null {
  const filePath = getGlobalCredsPath();
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf8').trim();
    return raw.length > 0 ? raw : null;
  } catch {
    // Unreadable (perms, race) — treat as absent, same as fileGet.
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface SetResult {
  storage: TokenStorage;
  /** Populated when storage === 'file_fallback'. */
  fallbackReason?: FallbackReason;
}

/**
 * Persist `token` for this project. Round-trips via a read-back to detect
 * sandboxed-keychain "silent write success, broken read" (CTO stop condition).
 * Falls back to file on any failure.
 */
export function setDeviceToken(
  absoluteProjectDir: string,
  token: string
): SetResult {
  const account = accountFor(absoluteProjectDir);
  const platform = platformSupportsKeychain();

  if (platform.supported) {
    try {
      macosKeychainSet(account, token);
      // Round-trip verification.
      const readBack = macosKeychainGet(account);
      if (readBack === token) {
        // Codex P1-1: when keychain write succeeds, ALSO delete any stale
        // file-fallback. Otherwise: if a user later runs `security
        // delete-generic-password ...` manually, getDeviceToken falls
        // through to the file and returns the OLD (possibly-revoked)
        // token. Single source of truth = keychain when keychain works.
        fileDelete(absoluteProjectDir);
        return { storage: 'keychain' };
      }
      // Wrote something the keychain didn't return — fall through to file.
      fileSet(absoluteProjectDir, token);
      const reason: FallbackReason = 'roundtrip_failed';
      emitFallbackWarningOnce(reason, getProjectScopedCredsPath(absoluteProjectDir));
      return { storage: 'file_fallback', fallbackReason: reason };
    } catch {
      fileSet(absoluteProjectDir, token);
      const reason: FallbackReason = 'write_failed';
      emitFallbackWarningOnce(reason, getProjectScopedCredsPath(absoluteProjectDir));
      return { storage: 'file_fallback', fallbackReason: reason };
    }
  }

  fileSet(absoluteProjectDir, token);
  emitFallbackWarningOnce(
    platform.reason ?? 'no_keychain',
    getProjectScopedCredsPath(absoluteProjectDir)
  );
  return { storage: 'file_fallback', fallbackReason: platform.reason };
}

/**
 * Read the device token. Tries keychain first, then project-scoped file,
 * then the machine-wide global file (`~/.mysecond/credentials`, v1.12.0).
 * Returns null when all three miss.
 *
 * Precedence invariant: a PRESENT-but-malformed higher-precedence store
 * hard-stops resolution (returns null → re-auth prompt) rather than
 * silently falling through to a lower-precedence credential. That was
 * already the keychain→file behavior; the global fallback keeps it.
 */
export function getDeviceToken(absoluteProjectDir: string): ReadResult | null {
  const platform = platformSupportsKeychain();

  if (platform.supported) {
    const account = accountFor(absoluteProjectDir);
    const fromKeychain = macosKeychainGet(account);
    if (fromKeychain !== null) {
      const { token, apiUrl } = normalizeStoredCredential(fromKeychain);
      // Empty token => normalizer rejected the stored value (malformed
      // structured input, or hit the control-char post-check). Treat as
      // "no credential" so downstream prompts re-auth instead of
      // pasting a bad bearer.
      if (token.length === 0) return null;
      return { token, storage: 'keychain', apiUrl };
    }
  }

  const fromFile = fileGet(absoluteProjectDir);
  if (fromFile !== null) {
    const { token, apiUrl } = normalizeStoredCredential(fromFile);
    if (token.length === 0) return null;
    return { token, storage: 'file_fallback', apiUrl };
  }

  // Final fallback: the machine-wide file the `/mysecond` login skill
  // writes. Only consulted when nothing project-scoped exists at all —
  // project-scoped stores always win. Malformed content is "no
  // credential" (normalizer returns empty), never a crash or a bad
  // bearer.
  const fromGlobal = globalFileGet();
  if (fromGlobal !== null) {
    const { token, apiUrl } = normalizeStoredCredential(fromGlobal);
    if (token.length === 0) return null;
    return { token, storage: 'global_file', apiUrl };
  }
  return null;
}

/**
 * Best-effort delete from BOTH project-scoped stores. Used by
 * `mysecond doctor --reset`.
 *
 * Deliberately does NOT touch the global `~/.mysecond/credentials` file:
 * it is machine-wide (written by `/mysecond` login, shared across every
 * project on the machine), so a per-project reset must not log out all
 * other projects. Re-running `/mysecond` overwrites it; deleting it by
 * hand is the manual escape hatch.
 */
export function clearDeviceToken(absoluteProjectDir: string): void {
  if (platformSupportsKeychain().supported) {
    macosKeychainDelete(accountFor(absoluteProjectDir));
  }
  fileDelete(absoluteProjectDir);
  // Make sure parent dir exists for future writes.
  try {
    mkdirSync(dirname(getProjectScopedCredsPath(absoluteProjectDir)), {
      recursive: true,
    });
  } catch {
    /* best-effort */
  }
}
