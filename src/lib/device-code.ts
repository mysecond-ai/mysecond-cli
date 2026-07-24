// Device-code OAuth client (Workstream B / Phase 2a Day 3).
//
// Talks to the unauthenticated `/api/companion/device/{code,token}` endpoints
// to acquire a long-lived bearer token without requiring the customer to
// paste a credential.
//
// Flow:
//   1. POST /device/code → server returns user_code + device_code
//   2. Print URL to chat (CAIO #10 — print BEFORE open attempt; the chat is
//      the deterministic surface), then attempt browser open
//   3. Poll POST /device/token every interval_seconds until:
//        - 200 → return { access_token, ... }
//        - 400 already_exchanged | invalid | expired → throw
//        - 400 authorization_pending → wait + retry
//        - 540s elapsed → throw TIMEOUT (10% safety under Claude Code's max
//          Bash-tool timeout; see POLL_HARD_CAP_SECONDS for the corrected
//          rationale — the old "hook reaper" attribution was wrong)
//
// Brief: ~/.claude/plans/workstream-b-device-code-brief.md

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// ── Types ──────────────────────────────────────────────────────────────────

export interface DeviceCodeResponse {
  user_code: string;
  device_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scopes: readonly string[];
  team_id: string;
  user_id: string;
}

export class DeviceCodeError extends Error {
  constructor(
    public readonly code:
      | 'expired'
      | 'invalid'
      | 'already_exchanged'
      | 'rate_limited'
      | 'timeout'
      | 'network'
      | 'protocol',
    message: string
  ) {
    super(message);
    this.name = 'DeviceCodeError';
  }
}

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * 10% safety margin under Claude Code's MAX Bash-tool timeout (600s —
 * `BASH_MAX_TIMEOUT_MS` default; the paste instructs a 600000 ms timeout for
 * Step 2). Correction (install-wall review, 2026-07-24): earlier comments
 * attributed this to a "600s PostToolUse hook reaper" — hook timeouts govern
 * hook subprocesses, not this Bash-tool command. Also note current Claude
 * Code AUTO-BACKGROUNDS a command at its timeout rather than killing it; the
 * cap still matters because it surfaces an actionable error while the agent
 * is foreground-attached instead of from a background output file.
 */
export const POLL_HARD_CAP_SECONDS = 540;

/** Default fetch timeout for individual /code and /token round-trips. */
const FETCH_TIMEOUT_MS = 15_000;

// ── Install-id (anonymous, device-scoped, persisted) ───────────────────────

/**
 * Persistent UUID identifying the *machine* (not the user). Stored at
 * ~/.mysecond/install-id so it survives reinstalls of a single project but
 * doesn't leak across machines. Aliased to user_id once device-authorized.
 */
export function getOrCreateInstallId(): string {
  const dir = join(homedir(), '.mysecond');
  const path = join(dir, 'install-id');
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf8').trim();
      if (raw.length > 0 && raw.length <= 128) return raw;
    } catch {
      // fall through to mint a new one
    }
  }
  const id = randomUUID();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, id + '\n', { mode: 0o600 });
    lastInstallIdWriteError = null;
  } catch (err) {
    // Best-effort — return the in-memory value either way. Record the
    // failure: EACCES/EPERM on ~/.mysecond is the fingerprint of Claude
    // Code's sandbox filesystem isolation (writes allowed only in CWD +
    // session TMPDIR), which also blocks the marketplace install later.
    // init-runner beacons `sandbox_suspected` off this (install-wall plan).
    lastInstallIdWriteError = err as NodeJS.ErrnoException;
  }
  return id;
}

let lastInstallIdWriteError: NodeJS.ErrnoException | null = null;

/** Non-null when the last getOrCreateInstallId() couldn't persist to
 *  ~/.mysecond. Callers with a CommandContext use this to beacon
 *  `sandbox_suspected` (they have apiBase; this module doesn't). */
export function getInstallIdWriteError(): NodeJS.ErrnoException | null {
  return lastInstallIdWriteError;
}

// ── HTTP ───────────────────────────────────────────────────────────────────

interface DeviceCodeFetchOptions {
  apiBase: string;
  cliVersion: string;
  installId: string;
  timeoutMs?: number;
}

async function unauthedFetch(
  path: string,
  body: unknown,
  opts: DeviceCodeFetchOptions
): Promise<{ status: number; body: unknown }> {
  const url = new URL(path, opts.apiBase);
  const signal = AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': `mysecond-cli/${opts.cliVersion} (${process.platform}; node-${process.versions.node})`,
        'x-mysecond-install-id': opts.installId,
      },
      body: JSON.stringify(body ?? {}),
      signal,
    });
    let parsed: unknown = null;
    const text = await response.text();
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: response.status, body: parsed };
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === 'TimeoutError' || err.name === 'AbortError')
    ) {
      throw new DeviceCodeError('network', `request to ${path} timed out`);
    }
    throw new DeviceCodeError(
      'network',
      err instanceof Error ? err.message : String(err)
    );
  }
}

// ── /device/code ───────────────────────────────────────────────────────────

export async function requestDeviceCode(
  opts: DeviceCodeFetchOptions
): Promise<DeviceCodeResponse> {
  const { status, body } = await unauthedFetch('/api/companion/device/code', {}, opts);
  if (status !== 200) {
    if (status === 429) {
      throw new DeviceCodeError('rate_limited', 'Too many code requests; try again in a minute');
    }
    throw new DeviceCodeError('protocol', `device/code returned status ${status}`);
  }
  if (!isDeviceCodeResponse(body)) {
    throw new DeviceCodeError('protocol', 'device/code returned malformed response');
  }
  return body;
}

function isDeviceCodeResponse(body: unknown): body is DeviceCodeResponse {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.user_code === 'string' &&
    typeof b.device_code === 'string' &&
    typeof b.verification_uri === 'string' &&
    typeof b.verification_uri_complete === 'string' &&
    typeof b.expires_in === 'number' &&
    typeof b.interval === 'number'
  );
}

// ── /device/token (polling) ────────────────────────────────────────────────

export interface PollOptions extends DeviceCodeFetchOptions {
  deviceCode: string;
  intervalSeconds: number;
  /** Override for tests; defaults to 540s per CAIO #9. */
  hardCapSeconds?: number;
  /** Called every poll for status reporting. */
  onTick?: (elapsedSeconds: number) => void;
}

export async function pollForToken(opts: PollOptions): Promise<TokenResponse> {
  const cap = opts.hardCapSeconds ?? POLL_HARD_CAP_SECONDS;
  const start = Date.now();
  const intervalMs = Math.max(opts.intervalSeconds, 1) * 1000;

  // First poll fires immediately (so a fast browser-side authorize completes
  // in ~5s rather than waiting for the first interval), then every intervalMs.
  while (true) {
    const elapsedSeconds = (Date.now() - start) / 1000;
    if (elapsedSeconds > cap) {
      throw new DeviceCodeError(
        'timeout',
        `Authorization timed out after ${Math.floor(cap)}s. Re-run mysecond init to retry.`
      );
    }
    if (opts.onTick) opts.onTick(elapsedSeconds);

    const { status, body } = await unauthedFetch(
      '/api/companion/device/token',
      { device_code: opts.deviceCode },
      opts
    );

    if (status === 200) {
      if (!isTokenResponse(body)) {
        throw new DeviceCodeError('protocol', 'device/token returned malformed success response');
      }
      return body;
    }
    if (status === 429) {
      throw new DeviceCodeError('rate_limited', 'Polling rate-limited; the cli is misbehaving — please report');
    }

    // 400 family — interpret error code.
    const errorCode =
      typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : 'protocol';

    switch (errorCode) {
      case 'authorization_pending':
        // expected — wait + continue
        await sleep(intervalMs);
        continue;
      case 'expired':
        throw new DeviceCodeError('expired', 'Code expired before authorization. Re-run mysecond init.');
      case 'already_exchanged':
        throw new DeviceCodeError(
          'already_exchanged',
          'This code was already used. Re-run mysecond init for a fresh code.'
        );
      case 'invalid':
        throw new DeviceCodeError('invalid', 'Server rejected the device_code. Re-run mysecond init.');
      default:
        throw new DeviceCodeError('protocol', `device/token returned status ${status} error=${errorCode}`);
    }
  }
}

function isTokenResponse(body: unknown): body is TokenResponse {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    // Codex P0-3: reject empty access_token. A buggy/compromised server
    // returning {access_token: ""} would otherwise silently install an
    // unusable credential ("installed but every API call fails").
    typeof b.access_token === 'string' &&
    b.access_token.length > 0 &&
    typeof b.team_id === 'string' &&
    b.team_id.length > 0 &&
    typeof b.user_id === 'string' &&
    b.user_id.length > 0 &&
    // Codex P1-4: validate scope element types. Array.isArray accepts any
    // element shape; downstream `scopes.join(', ')` would throw on objects.
    Array.isArray(b.scopes) &&
    b.scopes.every((s: unknown) => typeof s === 'string')
  );
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
