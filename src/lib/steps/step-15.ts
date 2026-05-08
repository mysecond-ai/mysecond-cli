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
import {
  fetchWhoami as fetchWhoamiShared,
  isTeamJoin,
  type WhoamiResponse,
} from '../api/whoami.js';

import type { CommandContext } from '../context.js';
import type { StepContext, StepFn } from './types.js';

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

  // ── default flow: pick up unexpired pending-auth state if present ────
  // If the customer ran `mysecond init --auth-only` recently and is now
  // running plain `mysecond init` (without --resume), poll the existing
  // device_code instead of minting a new one. Without this, plain init
  // would orphan the pending code (customer authorized code A in browser,
  // CLI now polls code B — hangs ~9 min then expires). Same logic
  // --resume uses; promotes it to the default path so customers using
  // either invocation get the resume behavior.
  const pending = readPendingAuth(ctx.rootDir);
  if (pending !== null) {
    if (!isPendingAuthExpired(pending)) {
      return runPollOnly(ctx, shared, pending);
    }
    // Stale pending state — clear it and fall through to fresh flow.
    clearPendingAuth(ctx.rootDir);
  }

  // ── ctx.apiKey already populated → validate via /whoami ───────────────
  if (ctx.apiKey.length > 0) {
    // Item 5B: capture email here too so step-13 can emit install_completed
    // with the customer's email even on the existing-credential-validated path.
    // Track T3: also captures team_id / team_slug / team_membership_role so
    // step-5b can bind them into project-scoped creds and step-6 can write
    // MYSECOND_TEAM_JOIN — even for customers who never run the device-code
    // flow (i.e., the apiKey was already valid from a prior install).
    const whoami = await fetchWhoami(ctx);
    if (whoami.ok) {
      applyWhoamiToShared(shared, whoami);
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
 * Thin local wrapper around the shared whoami client (`lib/api/whoami.ts`).
 * Track T3 (Closure D2) moved the network/timeout policy and the typed
 * response shape into a shared module so future callers (e.g., `mysecond
 * doctor`) can reuse it. Step-15 keeps its own thin function so the
 * call sites below (existing-credential validation, device-code happy
 * path, --resume poll) stay readable and we have one place to also
 * propagate the team-join fields onto `shared`.
 */
async function fetchWhoami(ctx: CommandContext): Promise<WhoamiResponse> {
  return fetchWhoamiShared({ apiBase: ctx.apiBase, apiKey: ctx.apiKey });
}

/**
 * Capture every whoami-derived field onto `shared` in one place. Called
 * from each happy-path return in step-15 so `shared.userEmail`,
 * `shared.teamId`, `shared.teamSlug`, `shared.teamMembershipRole`, and
 * `shared.isTeamJoin` are populated identically regardless of which auth
 * branch produced the token (existing-credential / device-code / resume).
 *
 * Safe-degrade: when whoami had a transient network failure or T2 hasn't
 * shipped the server-side fields yet, the team_* fields are null and
 * `isTeamJoin` returns false → downstream steps no-op their team-join
 * writes and the customer gets the Solo welcome.
 */
function applyWhoamiToShared(
  shared: StepContext['shared'],
  whoami: WhoamiResponse,
): void {
  if (whoami.email !== null) shared.userEmail = whoami.email;
  if (whoami.team_id !== null) shared.teamId = whoami.team_id;
  if (whoami.team_slug !== null) shared.teamSlug = whoami.team_slug;
  if (whoami.team_membership_role !== null) {
    shared.teamMembershipRole = whoami.team_membership_role;
  }
  // isTeamJoin is computed even on partial responses — false is the safe
  // default and matches what downstream steps treat as "no team-join".
  shared.isTeamJoin = isTeamJoin(whoami);
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
  // RED-TEAM: if a customer runs `--auth-only` twice without `--resume` in
  // between, a fresh mint would overwrite the previous pending-auth state.
  // The first device_code is then orphaned server-side; if the customer
  // authorized that one (e.g., from a chat that surfaced the first code),
  // `--resume` polls the SECOND code and fails silently. Reuse any unexpired
  // pending state instead of minting fresh.
  const existing = readPendingAuth(ctx.rootDir);
  if (existing !== null && !isPendingAuthExpired(existing)) {
    if (!ctx.silent) {
      printAuthBanner({
        user_code: existing.user_code,
        verification_uri: existing.verification_uri,
        expires_in: pendingAuthSecondsRemaining(existing),
      });
      printResumeHint(existing.slug);
    }
    // Reuse path: the original mint already emitted `device_code_minted`.
    // Re-emitting here would double-count mints in downstream telemetry/
    // dashboards. Skip — no new event needed for re-displaying the same code.
    return {
      step: 15,
      outcome: { kind: 'completed' },
      message: ctx.silent
        ? undefined
        : 'step 15: reusing unexpired device code (auth-only mode)',
    };
  }

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

  // Best-effort whoami for step-13 email + Track T3 team-join detection.
  // applyWhoamiToShared no-ops cleanly on networkError / missing fields.
  const whoami = await fetchWhoami(ctx);
  applyWhoamiToShared(shared, whoami);

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

  // Best-effort whoami for step-13 email + Track T3 team-join detection.
  // applyWhoamiToShared no-ops cleanly on networkError / missing fields.
  const whoami = await fetchWhoami(ctx);
  applyWhoamiToShared(shared, whoami);

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
