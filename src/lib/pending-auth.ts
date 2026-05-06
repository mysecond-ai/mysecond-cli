// Pending auth state — persisted between `mysecond init --auth-only` and
// `mysecond init --resume` (v1.4.2 two-command auth flow).
//
// Why split into two commands: Claude Code Desktop's bash tool runs single
// commands in BACKGROUND mode ("No streaming: Results returned after
// completion") — the agent doesn't surface auth-code stdout/stderr until the
// 9-min token-poll completes. Customer never sees the code. Splitting the
// flow into a fast-exit auth-mint command + a separate resume command makes
// the auth phase fast enough that the agent surfaces output naturally.
//
// File lives at `~/.mysecond/projects/<projectHash>/pending-auth.json`,
// chmod 600. Cleaned up on successful resume OR on detection of expiry.

import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';

import { atomicWriteFile } from './atomic-write.js';
import { pendingAuthDir, pendingAuthPath } from './mysecond-paths.js';

export interface PendingAuthState {
  device_code: string;
  user_code: string;
  verification_uri: string;
  /** ISO-8601 UTC timestamp of code expiry. */
  expires_at: string;
  /** Server-suggested polling interval in seconds. */
  interval_seconds: number;
  /** Slug we minted the code against (mostly debug surface; not load-bearing). */
  slug: string;
  /** ISO-8601 UTC timestamp the code was minted. */
  minted_at: string;
}

/** Persist pending auth state at chmod 600. Atomic write + chmod hardening. */
export function writePendingAuth(
  absoluteProjectDir: string,
  state: PendingAuthState
): void {
  const dir = pendingAuthDir(absoluteProjectDir);
  mkdirSync(dir, { recursive: true });
  const path = pendingAuthPath(absoluteProjectDir);
  atomicWriteFile(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  // Defensive — atomicWriteFile uses rename, which preserves source mode but
  // can survive a pre-existing wider-mode dest on some filesystems.
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort; the atomic write already passed.
  }
}

/** Read pending auth state. Returns null if file is missing or unreadable. */
export function readPendingAuth(
  absoluteProjectDir: string
): PendingAuthState | null {
  const path = pendingAuthPath(absoluteProjectDir);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PendingAuthState>;
    if (
      typeof parsed.device_code !== 'string' ||
      typeof parsed.user_code !== 'string' ||
      typeof parsed.verification_uri !== 'string' ||
      typeof parsed.expires_at !== 'string' ||
      typeof parsed.interval_seconds !== 'number' ||
      typeof parsed.slug !== 'string' ||
      typeof parsed.minted_at !== 'string'
    ) {
      return null;
    }
    return parsed as PendingAuthState;
  } catch {
    return null;
  }
}

/** Best-effort delete. No-op if missing. */
export function clearPendingAuth(absoluteProjectDir: string): void {
  try {
    unlinkSync(pendingAuthPath(absoluteProjectDir));
  } catch {
    // No-op if not present.
  }
}

/** True if the persisted state is past its expires_at. */
export function isPendingAuthExpired(state: PendingAuthState): boolean {
  const expires = Date.parse(state.expires_at);
  if (!Number.isFinite(expires)) return true;
  return Date.now() >= expires;
}

/** Seconds remaining until expiry; 0 if already expired or unparseable. */
export function pendingAuthSecondsRemaining(state: PendingAuthState): number {
  const expires = Date.parse(state.expires_at);
  if (!Number.isFinite(expires)) return 0;
  const remainingMs = expires - Date.now();
  return Math.max(0, Math.floor(remainingMs / 1000));
}
