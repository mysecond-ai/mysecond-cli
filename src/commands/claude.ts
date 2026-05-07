// `mysecond claude` — launch wrapper for Claude Code that synchronously pulls
// the latest plugin tarball before exec'ing the real `claude` binary.
//
// WHY: Anthropic's SessionStart hook fires AFTER plugins load — a SessionStart
// hook that pulls a new tarball cannot use it in the same session, so PMs see
// two-session lag (approve change → next session pulls → session-after-that
// uses it). The wrapper inverts the order: pull first, then start the session.
//
// CANONICAL PLAN: `~/.claude/plans/stateless-leaping-planet.md` Round 2 P0-A
// (lines 77–88).
//
// CONTRACT
//   1. Spawn 'claude' with all pass-through args. ENOENT → exit 127 with
//      install message (matches step-9.ts pattern).
//   2. If credentials file is absent → silent fall-through, no banner. The
//      machine isn't enrolled in mySecond, no warning needed.
//   3. If creds exist + slug known → fetch /api/companion/plugin-tarball/{slug}
//      with 5 s hard timeout (AbortSignal.timeout).
//   4. Compare server `version` to local LKG-cached version. Same → skip
//      download. Different → download + verify SHA + extract + atomic-rename
//      into marketplaceDir(slug) + cache as new LKG.
//   5. ANY error in steps 3–4 → stderr warning, fall through to spawn claude.
//      Wrapper is fail-open; never blocks the PM from working.
//   6. Exit code/signal of the spawned claude is propagated.
//
// SOLO BEHAVIOR
//   Per orchestrator decision: always-pull. Solo customers also have a
//   customer_plugins row; if the server returns same version we no-op
//   immediately. The 5 s timeout caps the worst-case latency cost.
//
// ZERO TELEMETRY
//   No emitTelemetry calls — wrapper is intentionally lean per brief.
//
// LOCK CONTENTION
//   The download/extract phase acquires `acquireMarketplaceLock` (same lock
//   as `mysecond init` step-9). Lock contention with concurrent `mysecond
//   sync` from another terminal blocks for up to ~500 ms before timing out;
//   on timeout we fall through to spawn claude with a warning. No deadlock
//   risk — the lock's stale-window auto-releases at 30 s.
//
// PLUGIN-FILE PICKUP
//   Empirical question: does Claude Code re-read plugin file contents per
//   session, or cache by content-hash? Smoke test (validated 2026-05-06):
//   replacing files under `~/.mysecond/marketplaces/customer-{slug}/plugin/`
//   IS picked up on the next `claude` launch — Claude Code reads plugin
//   manifest + skill files on session start. We do NOT need to spawn
//   `claude plugin update`. If a future Claude Code release adds content-hash
//   caching, we'd need to add that call here (it's a one-line change).
//   Documented in the wrapper's final report.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';

import type { CommandContext } from '../lib/context.js';
import { findLastKnownGood, cacheLastKnownGood } from '../lib/last-known-good.js';
import { acquireMarketplaceLock } from '../lib/marketplace-lock.js';
import {
  marketplaceDir,
  marketplaceTmpDir,
  pluginTmpExtractDir,
  validateSlug,
} from '../lib/mysecond-paths.js';
import { atomicRenameDir } from '../lib/atomic-write.js';
import { fetchAndExtractPlugin, type PluginTarballMeta } from '../lib/plugin-tarball.js';
import { readSyncState } from '../lib/sync-state.js';
import { join } from 'node:path';

const TARBALL_TIMEOUT_MS = 5_000;

// Local alias: the canonical PluginTarballMeta has `expires_at` which the
// metadata endpoint omits in the wrapper's path. We accept the narrower shape
// and widen with a synthetic expires_at when handing off to fetchAndExtractPlugin.
interface TarballMeta {
  signed_url: string;
  sha256: string;
  version: string;
}

/**
 * Entry point for `mysecond claude [...args]`.
 *
 * Returns the exit code that the parent CLI should propagate. The spawned
 * child's exit/error handlers resolve the returned promise with the appropriate
 * code; `main()` then returns that code, and the top-level entry in
 * `src/index.ts` calls `process.exit(code)`. Signal-terminated children are
 * re-raised on this process before resolving (see `execClaude` for details).
 */
export async function runClaude(
  args: readonly string[],
  ctx: CommandContext
): Promise<number> {
  // Best-effort update; never blocks beyond TARBALL_TIMEOUT_MS + extract time.
  // Wrapped in try/catch so any unexpected throw still falls through to
  // spawning claude. We are fail-open by design.
  try {
    await tryRefreshTarball(ctx);
  } catch (err) {
    process.stderr.write(
      `mysecond: update check failed (${err instanceof Error ? err.message : String(err)}) — using local copy.\n`
    );
  }

  return execClaude(args);
}

/**
 * Attempt to fetch the latest plugin tarball metadata, compare against the
 * local LKG version, and download+extract if the server has something newer.
 *
 * Fail-open: every failure path writes a stderr warning and returns. We never
 * throw out of this function for predictable failure classes — only for
 * truly-unexpected errors (which `runClaude`'s outer catch handles).
 */
async function tryRefreshTarball(ctx: CommandContext): Promise<void> {
  // Step A: do we even have credentials? If not → silent no-op (per
  // orchestrator decision: no banner when the machine has no companion).
  if (ctx.apiKey === '') {
    return;
  }

  // Step B: resolve customer slug from sync-state. If sync-state is missing
  // or has no slug, the install never completed — silent no-op (init will
  // bootstrap on first run).
  const state = readSyncState(ctx.rootDir);
  const rawSlug = state.customerSlug;
  if (rawSlug === null || rawSlug === '') {
    return;
  }

  let slug: string;
  try {
    slug = validateSlug(rawSlug);
  } catch {
    // Slug somehow invalid in sync-state — defensive; log and bail. Don't
    // build any FS paths from an unvalidated slug.
    process.stderr.write(
      'mysecond: invalid customer slug in sync-state — skipping update check.\n'
    );
    return;
  }

  // Step C: hit the tarball endpoint with 5 s hard timeout.
  let meta: TarballMeta;
  try {
    meta = await fetchTarballMeta(ctx.apiBase, ctx.apiKey, slug);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'TIMEOUT') {
      process.stderr.write(
        'mysecond: update check timed out — using local copy.\n'
      );
    } else {
      process.stderr.write(
        `mysecond: could not check for updates (${msg}) — using local copy.\n`
      );
    }
    return;
  }

  // Step D: version compare. The LKG index is the authoritative record of
  // what's installed locally — same field the server returns.
  const lkg = findLastKnownGood(slug);
  if (lkg !== null && lkg.version === meta.version) {
    // No update needed — common case on every launch.
    return;
  }

  // Step E: download + extract under a marketplace lock (serialize against
  // any concurrent `mysecond sync` / `mysecond init`).
  let lock: { release: () => Promise<void> };
  try {
    lock = await acquireMarketplaceLock();
  } catch (err) {
    process.stderr.write(
      `mysecond: another mysecond process is running — skipping update (${err instanceof Error ? err.message : String(err)}).\n`
    );
    return;
  }

  try {
    await downloadVerifyExtract(ctx, slug, meta);
    // Update LKG so the next launch's version compare sees the new value.
    cacheLastKnownGood(
      slug,
      meta.version,
      meta.sha256,
      join(marketplaceDir(slug), 'plugin')
    );
    process.stderr.write(
      `mysecond: updated plugin to v${meta.version}.\n`
    );
  } catch (err) {
    process.stderr.write(
      `mysecond: update download failed (${err instanceof Error ? err.message : String(err)}) — using local copy.\n`
    );
  } finally {
    try {
      await lock.release();
    } catch {
      // best-effort
    }
  }
}

/**
 * Fetch /api/companion/plugin-tarball/[slug]. Returns metadata on 200,
 * throws Error('TIMEOUT' | 'HTTP NNN' | 'malformed body' | 'network') on any
 * failure class. Caller maps these to stderr warnings.
 */
async function fetchTarballMeta(
  apiBase: string,
  apiKey: string,
  slug: string
): Promise<TarballMeta> {
  let url: URL;
  try {
    url = new URL(`/api/companion/plugin-tarball/${encodeURIComponent(slug)}`, apiBase);
  } catch {
    throw new Error('malformed apiBase');
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(TARBALL_TIMEOUT_MS),
    });
  } catch (err) {
    // AbortSignal.timeout produces a DOMException with name='TimeoutError'.
    // Both fetch's network errors and AbortError land here — distinguish.
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error('TIMEOUT');
    }
    throw new Error('network');
  }

  if (response.status !== 200) {
    throw new Error(`HTTP ${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('malformed body');
  }

  if (
    body === null ||
    typeof body !== 'object' ||
    typeof (body as Record<string, unknown>).signed_url !== 'string' ||
    typeof (body as Record<string, unknown>).sha256 !== 'string' ||
    typeof (body as Record<string, unknown>).version !== 'string'
  ) {
    throw new Error('malformed body');
  }

  const b = body as { signed_url: string; sha256: string; version: string };
  return { signed_url: b.signed_url, sha256: b.sha256, version: b.version };
}

/**
 * Download the tarball, verify SHA-256, extract into the customer marketplace
 * dir via atomic rename. Delegates the download/verify/extract trio to
 * `fetchAndExtractPlugin` (same code path step-9 uses) so we get its actionable
 * 401/403 CDN messaging + 30 s slow-loris timeout for free, then wraps it with
 * the wrapper-specific marketplace.json preservation + atomic swap.
 *
 * No `claude plugin install` re-run: the plugin is already registered with
 * Claude Code from `mysecond init`; replacing files in-place under
 * ~/.mysecond/marketplaces/customer-{slug}/plugin/ is sufficient.
 */
async function downloadVerifyExtract(
  ctx: CommandContext,
  slug: string,
  meta: TarballMeta
): Promise<void> {
  const tmpMarketplace = marketplaceTmpDir(slug);
  const tmpExtract = pluginTmpExtractDir(slug);
  const tmpTarball = join(tmpMarketplace, 'plugin.tgz');

  // Clean any stale tmp from a crashed prior run.
  rmSync(tmpMarketplace, { recursive: true, force: true });
  mkdirSync(tmpExtract, { recursive: true });

  // Canonical helper handles: GET signed_url with 30s timeout, streaming
  // SHA-256 verify, tarball extract. Throws MysecondError on CDN 401/403 with
  // actionable copy. We widen the meta shape with a synthetic expires_at since
  // the helper's type requires it but doesn't read it.
  const fullMeta: PluginTarballMeta = { ...meta, expires_at: '' };
  await fetchAndExtractPlugin(ctx, fullMeta, tmpTarball, tmpExtract);

  // Preserve the existing outer `.claude-plugin/marketplace.json` so Claude
  // Code's marketplace registration survives the swap. The CLI's outer
  // manifest is generated at install time from the tarball-internal manifest
  // — for the wrapper's hot-swap we copy the existing one over from the
  // current marketplace dir into the tmp dir before atomic-rename.
  const currentMarketplaceJson = join(
    marketplaceDir(slug),
    '.claude-plugin',
    'marketplace.json'
  );
  if (existsSync(currentMarketplaceJson)) {
    const tmpMarketplaceJsonDir = join(tmpMarketplace, '.claude-plugin');
    mkdirSync(tmpMarketplaceJsonDir, { recursive: true });
    const { copyFileSync } = await import('node:fs');
    copyFileSync(
      currentMarketplaceJson,
      join(tmpMarketplaceJsonDir, 'marketplace.json')
    );
  }

  // Atomic swap: tmp dir → final marketplace dir.
  atomicRenameDir(tmpMarketplace, marketplaceDir(slug));
}

/**
 * Signals we forward from the wrapper to the spawned claude child. SIGINT
 * (Ctrl-C in TTY also delivered to whole process group, but a programmatic
 * `kill <wrapper-pid>` would skip the child — explicit forwarding closes that
 * gap). SIGTERM is the standard polite-shutdown signal sent by init systems
 * and `kill`. SIGHUP fires when the controlling terminal closes — we want
 * claude to see it too. Adversarial-review fix (T5 P1-2).
 */
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * Spawn the real `claude` binary, propagating stdio, exit code, and signals.
 * Returns the exit code only on the "couldn't spawn at all" path (ENOENT
 * / sync spawn failure). On the happy path the returned promise resolves with
 * the child's exit code; the caller (`runClaude` → `main()` → `src/index.ts`)
 * calls `process.exit(code)`. Signal-terminated children re-raise the signal
 * on this process before resolving so the parent shell sees the canonical
 * "killed by SIGINT" semantics.
 */
function execClaude(args: readonly string[]): Promise<number> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn('claude', [...args], { stdio: 'inherit' });
    } catch (err) {
      // Synchronous spawn error — extremely rare (usually only on bad args).
      process.stderr.write(
        `mysecond: failed to spawn claude (${err instanceof Error ? err.message : String(err)}).\n`
      );
      resolve(1);
      return;
    }

    // Forward SIGINT/SIGTERM/SIGHUP to the child so a programmatic
    // `kill <wrapper-pid>` doesn't orphan claude. Track handlers so we can
    // remove them on child exit and avoid leaking listeners across multiple
    // wrapper runs in the same Node process (e.g., during tests).
    const handlers = new Map<NodeJS.Signals, () => void>();
    for (const sig of FORWARDED_SIGNALS) {
      const handler = (): void => {
        // Best-effort: child may have already exited. `kill` throws ESRCH
        // in that case; swallow it.
        try {
          child.kill(sig);
        } catch {
          // best-effort
        }
      };
      handlers.set(sig, handler);
      process.on(sig, handler);
    }
    const cleanup = (): void => {
      for (const [sig, handler] of handlers) {
        process.off(sig, handler);
      }
      handlers.clear();
    };

    child.on('error', (err: NodeJS.ErrnoException) => {
      cleanup();
      if (err.code === 'ENOENT') {
        // Match step-9.ts pattern: surface a clear install message.
        process.stderr.write(
          "mysecond: 'claude' not found on PATH.\n" +
            'Install Claude Code from https://claude.com/claude-code, then re-run.\n'
        );
        resolve(127);
        return;
      }
      process.stderr.write(
        `mysecond: claude spawn error: ${err.message}\n`
      );
      resolve(1);
    });

    child.on('exit', (code, signal) => {
      cleanup();
      if (signal !== null) {
        // Re-raise the signal on ourselves so the parent shell sees the
        // canonical "killed by SIGINT" semantics rather than exit 130.
        process.kill(process.pid, signal);
        // Fallback if signal didn't terminate us (rare).
        resolve(128 + 1);
        return;
      }
      resolve(code ?? 0);
    });
  });
}

// Test seam — exposes the internal helpers for unit tests without re-exporting
// them as part of the public command API.
export const __testing = {
  fetchTarballMeta,
  downloadVerifyExtract,
  tryRefreshTarball,
  execClaude,
  FORWARDED_SIGNALS,
  TARBALL_TIMEOUT_MS,
};
