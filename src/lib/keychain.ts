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
  getProjectScopedCredsPath,
  getProjectScopedCredsDir,
} from './creds-path.js';
import { mkdirSync } from 'node:fs';
import { projectHash } from './project-hash.js';

/** Where the token came from on a successful read. */
export type TokenStorage = 'keychain' | 'file_fallback';

export interface ReadResult {
  token: string;
  storage: TokenStorage;
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
 * Read the device token. Tries keychain first, then file fallback. Returns
 * null when both miss.
 */
export function getDeviceToken(absoluteProjectDir: string): ReadResult | null {
  const platform = platformSupportsKeychain();

  if (platform.supported) {
    const account = accountFor(absoluteProjectDir);
    const fromKeychain = macosKeychainGet(account);
    if (fromKeychain !== null) {
      return { token: fromKeychain, storage: 'keychain' };
    }
  }

  const fromFile = fileGet(absoluteProjectDir);
  if (fromFile !== null) {
    return { token: fromFile, storage: 'file_fallback' };
  }
  return null;
}

/** Best-effort delete from BOTH stores. Used by `mysecond doctor --reset`. */
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
