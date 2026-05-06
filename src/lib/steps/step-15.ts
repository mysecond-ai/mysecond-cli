// Step 15: Device-code OAuth (Workstream B / Phase 2a Day 4).
//
// Runs FIRST in the step registry — before step 4's /install-ready poll —
// because every downstream step relies on ctx.apiKey being populated. For
// Workstream B customers, ctx.apiKey is the device-token bearer (msd_...);
// it is acquired here when context-build time didn't already source one.
//
// Note: keychain/file token recovery happens at context-build time
// (see context.ts buildContext). By the time this step runs, ctx.apiKey
// is either:
//   (a) empty — no credential anywhere; run device-code flow
//   (b) populated — either a fresh-from-keychain device token, an env-var
//       override, or a legacy companion_api_key
//
// Idempotency contract:
//   - With --resume: REVOKE the existing token (if any) on the server
//     before requesting a new code. Otherwise --resume is just "get a new
//     token alongside" — the old one stays valid for ~90 days, which
//     defeats the security purpose of --resume.
//   - Without --resume + ctx.apiKey populated: validate against /whoami
//     before trusting. A revoked token in .env would otherwise silently
//     bypass device-code and customer would be stuck with a working
//     ledger but failing API calls.
//   - Without --resume + ctx.apiKey empty: run full device-code flow.
//
// v1.4.2 — two-command auth flow:
//   - --auth-only: mint code, print ALL-CAPS banner + structured marker,
//     persist pending-auth state, return early. Runner exits after this
//     step (no further steps run).
//   - --resume + pending-auth state present: skip the mint, poll using the
//     persisted device_code, then continue with the rest of install. On
//     expiry of pending state: clear it and surface a clear "re-run with
//     --auth-only" message.
//   - Default flow (no flags): mint + poll inline, but print the new
//     ALL-CAPS banner before polling so SOME agents may surface it.
//
// Codex review fixes baked in: P0-1 (keychain read moved to buildContext),
// P0-2 (whoami validation before trust), P0-4 (revoke on --resume).
//
// Brief: ~/.claude/plans/workstream-b-device-code-brief.md

import {
  pollForToken,
  requestDeviceCode,
  getOrCreateInstallId,
  DeviceCodeError,
  type DeviceCodeResponse,
} from '../device-code.js';
import { clearDeviceToken, setDeviceToken } from '../keychain.js';
import { MysecondError } from '../errors.js';
import { emitStatus } from '../silent-status.js';
import {
  clearPendingAuth,
  isPendingAuthExpired,
  pendingAuthSecondsRemaining,
  readPendingAuth,
  writePendingAuth,
  type PendingAuthState,
} from '../pending-auth.js';

import type { CommandContext } from '../context.js';
import type { StepFn } from './types.js';

declare const __VERSION__: string;

const WHOAMI_TIMEOUT_MS = 10_000;

export const step15: StepFn = async ({ ctx, shared }) => {
  // ── --auth-only: mint, persist, exit ─────────────────────────────────
  // The runner detects ctx.authOnly and short-circuits the rest of the
  // pipeline after this step returns.
  if (ctx.authOnly) {
    return runAuthOnlyMint(ctx);
  }

  // ── --resume with pending-auth state: skip mint, poll only ──────────
  // The fast path for the two-command flow: customer ran --auth-only,
  // authorized in the browser, now runs --resume to finish install.
  if (ctx.resume) {
    const pending = readPendingAuth(ctx.rootDir);
    if (pending !== null) {
      if (isPendingAuthExpired(pending)) {
        clearPendingAuth(ctx.rootDir);
        throw new MysecondError(
          1,
          'Device code expired. Re-run with --auth-only to mint a fresh code.'
        );
      }
      return runPollOnly(ctx, shared, pending);
    }

    // --resume with NO pending state. Treat as the legacy resume (revoke +
    // full mint+poll inline) — preserves v1.4.0/1.4.1 behavior for callers
    // upgrading without re-running --auth-only.
    if (ctx.apiKey.length > 0) {
      await tryRevokeExistingToken(ctx);
      clearDeviceToken(ctx.rootDir);
      (ctx as { apiKey: string }).apiKey = '';
    }
    return runDeviceCodeFlow(ctx, shared);
  }

  // ── ctx.apiKey already populated → validate via /whoami ───────────────
  if (ctx.apiKey.length > 0) {
    // Item 5B: capture email here too so step-13 can emit install_completed
    // with the customer's email even on the existing-credential-validated path.
    const whoami = await fetchWhoami(ctx);
    if (whoami.ok) {
      if (whoami.email) shared.userEmail = whoami.email;
      return {
        step: 15,
        outcome: { kind: 'completed' },
        message: ctx.silent
          ? undefined
          : 'step 15: existing credential validated',
      };
    }
    // Existing key didn't validate (revoked, expired, or unauthenticatable).
    // Clear it and fall through to device-code flow.
    (ctx as { apiKey: string }).apiKey = '';
    if (!ctx.silent) {
      process.stdout.write(
        'step 15: existing credential rejected by server — re-authenticating\n'
      );
    }
  }

  return runDeviceCodeFlow(ctx, shared);
};

// ── /whoami validation ─────────────────────────────────────────────────────

/**
 * Probe /whoami with the current apiKey. Three outcomes:
 *   - { ok: true, email } — server returned 200; email captured for step-13.
 *   - { ok: false, email: null } — server explicitly rejected (4xx/5xx);
 *     caller should clear the key and re-authenticate.
 *   - { ok: true, email: null, networkError: true } — network failure /
 *     timeout. Don't lock the customer out on transient blips — trust the
 *     existing key. Worst case the next sync surfaces a 401 and the
 *     customer re-runs init then. Email is unknown so step-13 will fall
 *     back to a generic post-install message.
 */
async function fetchWhoami(
  ctx: CommandContext,
): Promise<{ ok: boolean; email: string | null; networkError?: boolean }> {
  try {
    const url = new URL('/api/companion/whoami', ctx.apiBase);
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        'user-agent': `mysecond-cli/${__VERSION__} (${process.platform}; node-${process.versions.node})`,
      },
      signal: AbortSignal.timeout(WHOAMI_TIMEOUT_MS),
    });
    if (response.status !== 200) return { ok: false, email: null };
    const body = (await response.json().catch(() => null)) as { email?: string | null } | null;
    return { ok: true, email: body?.email ?? null };
  } catch {
    // Network error / timeout — trust the existing key (preserves prior
    // validateExistingKey behavior). Email unknown; step-13 falls back.
    return { ok: true, email: null, networkError: true };
  }
}

// ── /revoke (single-token bearer-authed) ───────────────────────────────────

async function tryRevokeExistingToken(ctx: CommandContext): Promise<void> {
  try {
    const url = new URL('/api/companion/device/revoke', ctx.apiBase);
    await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        'user-agent': `mysecond-cli/${__VERSION__} (${process.platform}; node-${process.versions.node})`,
      },
      signal: AbortSignal.timeout(WHOAMI_TIMEOUT_MS),
    });
    // Don't fail the resume if revoke errors — best-effort. The new token
    // we're about to mint is the security guarantee; the old token's
    // continued validity is a smaller residual risk.
  } catch {
    // network error → fall through and continue with the resume.
  }
}

// ── Visual output: ALL-CAPS banner + structured marker ────────────────────

function printAuthBanner(
  codeResp: { user_code: string; verification_uri: string; expires_in: number }
): void {
  // Both formats per CAIO recommendation. ALL-CAPS banner survives LLM
  // chat summarization; structured marker enables agent regex parsing.
  // Written to stderr — Node block-buffers stdout when piped (Claude Code
  // Desktop's bash tool is a pipe), so a multi-line stdout.write can sit
  // in the buffer for 30s-2min; stderr flushes immediately.
  const expiresMins = Math.max(1, Math.round(codeResp.expires_in / 60));
  const lines = [
    '',
    '============================================================',
    '  AUTHORIZATION REQUIRED',
    '',
    `  Code:    ${codeResp.user_code}`,
    `  URL:     ${codeResp.verification_uri}`,
    `  Expires: ${expiresMins} minutes`,
    '============================================================',
    '',
    `[mysecond:auth-required] code=${codeResp.user_code} url=${codeResp.verification_uri} expires_in=${codeResp.expires_in}`,
    '',
    'Authorize at the URL above, paste the code, click Authorize.',
    '',
  ];
  process.stderr.write(lines.join('\n') + '\n');
}

function printResumeHint(slug: string): void {
  process.stderr.write(
    [
      'Then run this command to finish installation:',
      `  MYSECOND_CUSTOMER_SLUG=${slug} npx -y @mysecond/cli@latest init --resume`,
      '',
    ].join('\n') + '\n'
  );
}

// ── --auth-only: mint + persist + exit ────────────────────────────────────

async function runAuthOnlyMint(
  ctx: CommandContext,
): Promise<{ step: number; outcome: { kind: 'completed' }; message?: string }> {
  const installId = getOrCreateInstallId();
  const codeOpts = {
    apiBase: ctx.apiBase,
    cliVersion: __VERSION__,
    installId,
  };

  let codeResp: DeviceCodeResponse;
  try {
    codeResp = await requestDeviceCode(codeOpts);
  } catch (err) {
    if (err instanceof DeviceCodeError) {
      throw new MysecondError(
        1,
        `Couldn't request a device code (${err.code}): ${err.message}`
      );
    }
    throw err;
  }

  const slug = process.env.MYSECOND_CUSTOMER_SLUG ?? 'unknown';
  const mintedAt = new Date();
  const expiresAt = new Date(mintedAt.getTime() + codeResp.expires_in * 1000);

  const state: PendingAuthState = {
    device_code: codeResp.device_code,
    user_code: codeResp.user_code,
    verification_uri: codeResp.verification_uri,
    expires_at: expiresAt.toISOString(),
    interval_seconds: codeResp.interval,
    slug,
    minted_at: mintedAt.toISOString(),
  };
  writePendingAuth(ctx.rootDir, state);

  if (!ctx.silent) {
    printAuthBanner(codeResp);
    printResumeHint(slug);
  }

  emitStatus({
    kind: 'device_code_minted',
    user_code: codeResp.user_code,
    verification_uri: codeResp.verification_uri,
    expires_in: codeResp.expires_in,
  });

  return {
    step: 15,
    outcome: { kind: 'completed' },
    message: ctx.silent ? undefined : 'step 15: device code minted (auth-only mode)',
  };
}

// ── --resume from pending-auth state: poll only ───────────────────────────

async function runPollOnly(
  ctx: CommandContext,
  shared: import('./types.js').StepContext['shared'],
  pending: PendingAuthState,
): Promise<{ step: number; outcome: { kind: 'completed' }; message?: string }> {
  const installId = getOrCreateInstallId();
  const codeOpts = {
    apiBase: ctx.apiBase,
    cliVersion: __VERSION__,
    installId,
  };

  if (!ctx.silent) {
    process.stderr.write(
      [
        '',
        `Resuming install. Code: ${pending.user_code} (${pendingAuthSecondsRemaining(pending)}s remaining).`,
        'Waiting for authorization...',
        '',
      ].join('\n') + '\n'
    );
  }

  let tokenResp;
  try {
    tokenResp = await pollForToken({
      ...codeOpts,
      deviceCode: pending.device_code,
      intervalSeconds: pending.interval_seconds,
    });
  } catch (err) {
    if (err instanceof DeviceCodeError) {
      // On expired/invalid/already_exchanged, clear the stale state so the
      // customer's next --auth-only run starts clean.
      if (
        err.code === 'expired' ||
        err.code === 'invalid' ||
        err.code === 'already_exchanged'
      ) {
        clearPendingAuth(ctx.rootDir);
      }
      throw new MysecondError(
        1,
        `Device authorization failed (${err.code}): ${err.message}`
      );
    }
    throw err;
  }

  // Persist the token (keychain on macOS, file fallback elsewhere).
  const setResult = setDeviceToken(ctx.rootDir, tokenResp.access_token);

  // Mutate ctx for downstream steps.
  (ctx as { apiKey: string }).apiKey = tokenResp.access_token;

  // Successfully exchanged — clear pending state.
  clearPendingAuth(ctx.rootDir);

  // Best-effort whoami for step-13 email.
  const whoami = await fetchWhoami(ctx);
  if (whoami.email) {
    shared.userEmail = whoami.email;
  }

  if (
    setResult.fallbackReason === 'roundtrip_failed' ||
    setResult.fallbackReason === 'write_failed'
  ) {
    emitStatus({
      kind: 'keychain_write_failed',
      reason: setResult.fallbackReason,
    });
  }

  emitStatus({
    kind: 'device_authorized',
    token_storage: setResult.storage,
    keychain_unavailable_reason: setResult.fallbackReason ?? null,
  });

  if (!ctx.silent) {
    process.stdout.write(
      '\n  ✓ Device authorized. Continuing install...\n\n'
    );
  }

  return {
    step: 15,
    outcome: { kind: 'completed' },
    message: ctx.silent ? undefined : 'step 15: device authorized (resumed)',
  };
}

// ── Full device-code flow (legacy single-command path) ────────────────────

async function runDeviceCodeFlow(
  ctx: CommandContext,
  shared: import('./types.js').StepContext['shared'],
): Promise<{ step: number; outcome: { kind: 'completed' }; message?: string }> {
  const installId = getOrCreateInstallId();
  const codeOpts = {
    apiBase: ctx.apiBase,
    cliVersion: __VERSION__,
    installId,
  };

  // Fix C Step 1: measure device-code mint wall-clock.
  const mintStartMs = performance.now();
  let codeResp: DeviceCodeResponse;
  try {
    codeResp = await requestDeviceCode(codeOpts);
  } catch (err) {
    if (err instanceof DeviceCodeError) {
      throw new MysecondError(
        1,
        `Couldn't request a device code (${err.code}): ${err.message}`
      );
    }
    throw err;
  }
  const mintDurationMs = Math.round(performance.now() - mintStartMs);
  emitStatus({
    kind: 'device_code_minted_timed',
    duration_ms: mintDurationMs,
  });

  // v1.4.2: print the NEW ALL-CAPS banner BEFORE polling. Some agents may
  // surface this even in single-command mode. The banner replaces the prior
  // free-form Markdown link block — same information, deterministic shape.
  if (!ctx.silent) {
    printAuthBanner(codeResp);
    process.stdout.write('Waiting for authorization...\n');
  }

  emitStatus({
    kind: 'device_code_minted',
    user_code: codeResp.user_code,
    verification_uri: codeResp.verification_uri,
    expires_in: codeResp.expires_in,
  });

  // Poll until authorized or 540s cap.
  const pollStartMs = performance.now();
  let tokenResp;
  try {
    tokenResp = await pollForToken({
      ...codeOpts,
      deviceCode: codeResp.device_code,
      intervalSeconds: codeResp.interval,
    });
  } catch (err) {
    if (err instanceof DeviceCodeError) {
      throw new MysecondError(
        1,
        `Device authorization failed (${err.code}): ${err.message}`
      );
    }
    throw err;
  }
  const pollDurationMs = Math.round(performance.now() - pollStartMs);
  emitStatus({
    kind: 'device_authorized_timed',
    duration_ms: pollDurationMs,
  });

  // Persist the token (keychain on macOS, file fallback elsewhere).
  const setResult = setDeviceToken(ctx.rootDir, tokenResp.access_token);

  // Mutate ctx for downstream steps.
  (ctx as { apiKey: string }).apiKey = tokenResp.access_token;

  // Best-effort whoami for step-13 email.
  const whoami = await fetchWhoami(ctx);
  if (whoami.email) {
    shared.userEmail = whoami.email;
  }

  if (
    setResult.fallbackReason === 'roundtrip_failed' ||
    setResult.fallbackReason === 'write_failed'
  ) {
    emitStatus({
      kind: 'keychain_write_failed',
      reason: setResult.fallbackReason,
    });
  }

  emitStatus({
    kind: 'device_authorized',
    token_storage: setResult.storage,
    keychain_unavailable_reason: setResult.fallbackReason ?? null,
  });

  if (!ctx.silent) {
    process.stdout.write(
      '\n  ✓ Device authorized. Quit and reopen Claude Code to load the mySecond plugin — your install will continue automatically.\n\n'
    );
  }

  return {
    step: 15,
    outcome: { kind: 'completed' },
    message: ctx.silent ? undefined : 'step 15: device authorized',
  };
}
