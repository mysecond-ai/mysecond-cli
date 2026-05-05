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
// Codex review fixes baked in: P0-1 (keychain read moved to buildContext),
// P0-2 (whoami validation before trust), P0-4 (revoke on --resume).
//
// Brief: ~/.claude/plans/workstream-b-device-code-brief.md

import {
  pollForToken,
  requestDeviceCode,
  getOrCreateInstallId,
  DeviceCodeError,
} from '../device-code.js';
import { clearDeviceToken, setDeviceToken } from '../keychain.js';
import { MysecondError } from '../errors.js';
import { emitStatus } from '../silent-status.js';

import type { CommandContext } from '../context.js';
import type { StepFn } from './types.js';

declare const __VERSION__: string;

const WHOAMI_TIMEOUT_MS = 10_000;

export const step15: StepFn = async ({ ctx, shared }) => {
  // ── --resume: revoke first, then proceed to full flow ─────────────────
  if (ctx.resume) {
    if (ctx.apiKey.length > 0) {
      await tryRevokeExistingToken(ctx);
      // Codex pass 2 P1-3: clear the local cached token IMMEDIATELY after
      // revoke. Without this, a cli crash between revoke and new-token
      // mint would leave the keychain holding a now-revoked token. On
      // recovery (without --resume), getDeviceToken would return that
      // stale token, /whoami would 401, and the customer would see a
      // confusing "credential rejected" message before re-auth fires.
      clearDeviceToken(ctx.rootDir);
      // Clear in-memory key so the post-revoke flow doesn't try to reuse it.
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

// ── Full device-code flow ─────────────────────────────────────────────────

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

  let codeResp;
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

  // CAIO #10: print URL to stdout BEFORE the open attempt. The chat is the
  // deterministic surface; auto-open is best-effort.
  // Day 5 pre-launch: user_code is NOT in the URL — customer types it
  // into the page's input form. Print the code prominently with a copy-
  // friendly hint so the customer knows where to find it.
  //
  // Day 5+ Item 5A (CAIO P0): write the device-code block to STDERR, not
  // stdout. Node's process.stdout is block-buffered when piped (Claude Code
  // Desktop's bash tool is a pipe), so a multi-line stdout.write can sit
  // in the buffer for 30s-2min before the customer sees it. process.stderr
  // is unbuffered by default when piped — the code surfaces in chat in ~5s.
  // The trailing \n explicitly flushes the pipe.
  // "Waiting for authorization..." stays on stdout — lower urgency, fine
  // to buffer.
  if (!ctx.silent) {
    process.stderr.write(
      [
        '',
        'mySecond needs to authorize this device in your browser.',
        '',
        `  Code:  ${codeResp.user_code}    ← copy this`,
        `  Open:  ${codeResp.verification_uri_complete}`,
        '',
        'Type the code in the browser, then click Authorize.',
        '',
      ].join('\n') + '\n'
    );
    process.stdout.write('Waiting for authorization...\n');
  }

  // Silent JSON status: cli emits "device_code_minted" so the chat client
  // can render its own waiting UI without parsing prose stdout.
  emitStatus({
    kind: 'device_code_minted',
    user_code: codeResp.user_code,
    verification_uri: codeResp.verification_uri,
    expires_in: codeResp.expires_in,
  });

  // Poll until authorized or 540s cap.
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

  // Persist the token (keychain on macOS, file fallback elsewhere).
  const setResult = setDeviceToken(ctx.rootDir, tokenResp.access_token);

  // Mutate ctx for downstream steps.
  (ctx as { apiKey: string }).apiKey = tokenResp.access_token;

  // Item 5B: capture email from /whoami so step-13 can emit the
  // install_completed JSON status event with installCompleteClaudeMessage(email).
  // Best-effort — if /whoami fails here, step-13 falls back to a generic
  // post-install message.
  const whoami = await fetchWhoami(ctx);
  if (whoami.email) {
    shared.userEmail = whoami.email;
  }

  // Emit a keychain_write_failed status when we fell back due to round-trip
  // failure or write error (sandboxed-keychain edge case). Not a fatal
  // condition — file fallback is a working credential — but worth a
  // discriminable event so support can detect a sandboxed-keychain pattern
  // in PostHog without grepping logs (CAIO Day 4).
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

  // CXO Day 4: parallel non-silent success line so the customer in their
  // terminal sees an explicit "✓ authorized" instead of just "step 15:
  // device authorized" (which doesn't tell them what to do next).
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
