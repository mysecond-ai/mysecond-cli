// Install beacon — UNAUTHENTICATED pre-auth telemetry (install-wall plan).
//
// Why this exists: ~56% of paying teams never get Step 1 (`init --auth-only`)
// to reach the server. `/api/companion/telemetry` requires a Bearer token,
// which doesn't exist pre-auth, and `install.started` was explicitly guarded
// off in --auth-only mode — so the failing majority was invisible. This
// module POSTs to `/api/companion/install-beacon` (server: rate-limited,
// stage enum allowlisted, error text redacted server-side as well).
//
// Delivery contract:
//   - `emitBeacon()` returns a promise that NEVER rejects and resolves within
//     BEACON_TIMEOUT_MS regardless of network state.
//   - Callers on process-EXIT paths (wrong-window exit 2, mint-failure throw)
//     must AWAIT it — fire-and-forget on an exit path is a beacon that dies
//     with the process, and failure paths are the entire point of this
//     module. A ≤3s delay on a path that ends in an error message is
//     acceptable.
//   - Callers on continuing paths (cli_started at init entry) `void` it.
//
// Stage names MUST exist in the server's allowlist
// (mysecond-app src/app/api/companion/install-beacon/route.ts STAGES) —
// an unknown stage is a 400 and the event is silently lost.

declare const __VERSION__: string;

export const BEACON_TIMEOUT_MS = 3_000;

export type BeaconStage =
  | 'cli_started'
  | 'wrong_window'
  | 'mint_failed'
  | 'sandbox_suspected';

export interface BeaconInput {
  apiBase: string;
  installId: string;
  stage: BeaconStage;
  slug?: string;
  errorClass?: string;
  /** First ~400 chars of error output. Server-side redaction also applies. */
  errorExcerpt?: string;
}

/**
 * POST one beacon event. Resolves (never rejects) when the request settles
 * or the timeout fires — whichever comes first.
 *
 * MYSECOND_NO_BEACON=1 disables emission entirely — set by the test suite
 * (tests spawn the REAL built binary; without this, every local/CI run
 * would POST wrong_window/cli_started events to production and pollute the
 * install funnel the beacon exists to measure). Same pattern as
 * MYSECOND_NO_KEYCHAIN.
 */
export async function emitBeacon(input: BeaconInput): Promise<void> {
  if (process.env.MYSECOND_NO_BEACON === '1') return;
  try {
    const url = new URL('/api/companion/install-beacon', input.apiBase);
    await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': `mysecond-cli/${__VERSION__} (${process.platform}; node-${process.versions.node})`,
        'x-mysecond-install-id': input.installId,
      },
      body: JSON.stringify({
        stage: input.stage,
        ...(input.slug !== undefined && input.slug !== '' ? { slug: input.slug } : {}),
        os: process.platform,
        node_version: process.versions.node,
        cli_version: __VERSION__,
        ...(input.errorClass !== undefined ? { error_class: input.errorClass.slice(0, 64) } : {}),
        ...(input.errorExcerpt !== undefined
          ? { error_excerpt: input.errorExcerpt.slice(0, 400) }
          : {}),
      }),
      signal: AbortSignal.timeout(BEACON_TIMEOUT_MS),
    });
  } catch {
    // Silently swallow — the beacon must never affect CLI behavior, output,
    // or exit codes. (Timeout, DNS failure, 4xx/5xx: all irrelevant to the
    // customer's install.)
  }
}
