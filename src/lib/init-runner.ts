// Init runner — orchestrates the 13 steps + handles SIGINT + manages ledger
// + does stale-tmp cleanup on resume. Spec §6 + §6.7.

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { emitTelemetry } from './api.js';
import { SIGINT_MESSAGE } from './copy.js';
import type { CommandContext } from './context.js';
import { MysecondError } from './errors.js';
import { isInClaudeCodeContext, WRONG_WINDOW_COPY } from './paste-detect.js';
import { marketplacesRoot } from './mysecond-paths.js';
import {
  isStepComplete,
  markStepComplete,
  readSyncState,
} from './sync-state.js';

import { STEPS, type StepEntry } from './steps/index.js';
import { runGitignoreGuard } from './steps/step-5b.js';
import type { StepContext } from './steps/types.js';

export async function runInit(ctx: CommandContext): Promise<number> {
  // Wrong-window detection FIRST (§6.9). Before any state mutation, before any
  // network call. Customer pasted into a regular terminal instead of Claude
  // Code's terminal — exit 2 with actionable copy.
  if (!isInClaudeCodeContext(ctx.rootDir)) {
    process.stderr.write(WRONG_WINDOW_COPY + '\n');
    return 2;
  }

  // Load state (or empty defaults).
  const state = readSyncState(ctx.rootDir);

  // CTO BLOCKING-1: install funnel telemetry. Fire-and-forget — never block
  // install on telemetry. Slug may not be known yet (comes from env or step 4),
  // so send what we have. Completed event fires after all 13 steps succeed.
  //
  // Guard against --auth-only: that mode runs only step 15 (device-code mint)
  // and exits — it is not part of the install funnel. install.completed is
  // already guarded the same way; firing started without completed would
  // artificially deflate the funnel ratio.
  const telemetrySlug = process.env.MYSECOND_CUSTOMER_SLUG ?? state.customerSlug ?? 'unknown';
  if (!ctx.authOnly) {
    void emitTelemetry(ctx, 'mysecond.install.started', {
      slug: telemetrySlug,
      resuming: state.initCompletedSteps !== undefined && state.initCompletedSteps.length > 0,
    });
  }

  // Stale-tmp cleanup on resume (CTO-2 + RT-1 lock-scoped — §6.2).
  // Scan ~/.mysecond/marketplaces/, .claude/sync-state.json parent dir,
  // .env parent, .claude/settings.json parent, CLAUDE.md parent for *.tmp-{pid}
  // files where {pid} is not a currently-running process.
  cleanupStaleTmps(ctx.rootDir);

  // SIGINT handler (§6.7). Critical correctness invariant: do NOT append
  // currently-in-flight step to ledger. Print copy + exit 130.
  let sigintFired = false;
  let currentStepNumber = 0;
  const onSigint = (): void => {
    if (sigintFired) return;
    sigintFired = true;
    process.stderr.write('\n' + SIGINT_MESSAGE + '\n');
    // RED-TEAM R2 P1-D: telemetry on SIGINT so support can see abandonment
    // patterns (e.g., always at step 9 = signed-URL fetch is hanging on slow
    // networks). Fire-and-forget; process.exit will likely cut it short, but
    // the request is queued before exit.
    void emitTelemetry(ctx, 'mysecond.init.abandoned_at_step_N', {
      customer_id: state.customerId ?? 'unknown',
      step_number: currentStepNumber,
      exit_code: 130,
    });
    // Stale tmp will be cleaned on next run by cleanupStaleTmps above. Don't
    // try to do it here — the in-flight step may still be writing, racing the
    // cleanup is worse than letting the next-run cleanup handle it.
    process.exit(130);
  };
  process.on('SIGINT', onSigint);

  const sctx: StepContext = {
    ctx,
    state,
    shared: {},
  };

  try {
    for (const entry of STEPS) {
      // v1.4.2 two-command auth flow: in --auth-only mode, run step 15
      // (device-code mint) only and exit. Subsequent steps wait for
      // `mysecond init --resume` to complete the install.
      if (ctx.authOnly && entry.number !== 15) {
        if (!ctx.silent && entry.number === 1) {
          // Print this once, after step 15 has run.
          process.stdout.write(
            '\n(auth-only mode: install will continue when you run --resume)\n'
          );
        }
        break;
      }

      // Step 15 (device-code OAuth) always runs, regardless of ledger state.
      // It is self-idempotent — `fetchWhoami()` validates an existing apiKey
      // before doing any device-code work, returning instantly on success.
      // It is also the ONLY mechanism that detects server-side token
      // revocation: without re-running it, a customer who revoked their
      // device from the dashboard would silently keep stale credentials and
      // hit 401s on every subsequent sync with no recovery path. The
      // happy-path cost is one /whoami round-trip (~200ms). v1.4.3 fix —
      // before this change, --resume was the only escape valve.
      const alwaysRunStep15 = entry.number === 15;
      if (isStepComplete(state, entry.number) && !alwaysRunStep15) {
        if (!ctx.silent) {
          process.stdout.write(`step ${entry.number}/${STEPS.length}: ${entry.description} — already done, skipping\n`);
        }
        continue;
      }

      if (ctx.dryRun && entry.mutates) {
        // --dry-run: skip mutating steps, log what would happen, never advance ledger.
        if (!ctx.silent) {
          process.stdout.write(`step ${entry.number}/${STEPS.length} (dry-run): would ${entry.description}\n`);
        }
        continue;
      }

      if (!ctx.silent) {
        process.stdout.write(`step ${entry.number}/${STEPS.length}: ${entry.description}…\n`);
      }
      // RED-TEAM R2 P1-D: track current step for SIGINT telemetry above.
      currentStepNumber = entry.number;
      let result;
      try {
        result = await entry.fn(sctx);
      } catch (err) {
        // Orphan-migration safety: if step-5 (.env write) throws — most
        // commonly an env conflict the customer didn't pass --fix for —
        // the gitignore guard from step-5b would otherwise never run, and
        // the customer's existing .env sits un-protected. Run the guard
        // here on the failure path so the security mitigation always lands.
        // No-op on success (step-5b runs the guard normally) and no-op
        // outside step 5 (other steps don't touch credentials).
        if (entry.number === 5) {
          try {
            runGitignoreGuard(ctx.rootDir, ctx.silent);
          } catch {
            // Guard itself failed — don't mask the original error.
          }
        }
        throw err;
      }

      if (result.message !== undefined && !ctx.silent) {
        process.stdout.write(result.message + '\n');
      }

      if (result.outcome.kind === 'aborted') {
        throw new MysecondError(1, `step ${entry.number} aborted: ${result.outcome.reason}`);
      }

      // Only persist ledger if NOT dry-run. Dry-run runs read-only steps fully
      // (Node version check, install-ready poll, plugin-load probe) but never
      // advances the ledger so the synthetic doesn't pollute the customer's
      // (or staging's) state.
      //
      // v1.4.2: in --auth-only mode, do NOT mark step 15 complete. The auth
      // hasn't actually completed — only the code was minted. --resume needs
      // step 15 to run again (in poll-only mode) to exchange the code for a
      // token. If we marked it complete here, --resume would skip step 15
      // entirely and try to run downstream steps with an empty apiKey.
      if (!ctx.dryRun && !(ctx.authOnly && entry.number === 15)) {
        markStepComplete(ctx.rootDir, state, entry.number);
      }
    }

    if (ctx.dryRun) {
      if (!ctx.silent) {
        process.stdout.write('\nDRY-RUN PASSED — would exit 0 on real run.\n');
      }
    } else if (!ctx.authOnly) {
      // CTO BLOCKING-1: emit install.completed on first-time success.
      // Re-runs (resume from partial) still emit — server can deduplicate on slug.
      // Guard against false positives from --auth-only: that mode mints a
      // device code and exits without completing the install. Emitting
      // install.completed on auth-only would inflate the install funnel
      // top-of-funnel metric for every two-command run.
      void emitTelemetry(ctx, 'mysecond.install.completed', {
        slug: sctx.shared.customerId ?? telemetrySlug,
      });
    }

    return 0;
  } finally {
    process.off('SIGINT', onSigint);
  }
}

// Stale-tmp cleanup pass — must run BEFORE reading initCompletedSteps so the
// runner can't act on a half-written ledger. Per §6.2, we scan multiple paths
// for `*.tmp-{pid}` (or `customer-{slug}.tmp-{pid}/` dirs under
// `~/.mysecond/marketplaces/`). For each stale tmp where {pid} is dead, unlink
// or recursive-delete.

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process (dead). EPERM = process exists but we can't
    // signal it (alive but owned by another user). Treat EPERM as alive to
    // avoid clobbering another user's tmp.
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

interface StaleEntry {
  fullPath: string;
  isDir: boolean;
}

function findStaleTmpsIn(dir: string): StaleEntry[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: StaleEntry[] = [];
  for (const name of entries) {
    // Match `<name>.tmp-<pid>` (file or dir). pid extracted from suffix.
    const match = /\.tmp-(\d+)(?:\/?)?$/.exec(name);
    if (match === null || match[1] === undefined) continue;
    const pid = Number(match[1]);
    if (isProcessAlive(pid)) continue;

    const fullPath = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(fullPath).isDirectory();
    } catch {
      continue;
    }
    out.push({ fullPath, isDir });
  }
  return out;
}

function cleanupStaleTmps(rootDir: string): void {
  const dirs = [
    marketplacesRoot(),
    join(rootDir, '.claude'),
    rootDir, // catches .env.tmp-* + CLAUDE.md.tmp-*
  ];
  for (const dir of dirs) {
    for (const stale of findStaleTmpsIn(dir)) {
      try {
        rmSync(stale.fullPath, { recursive: stale.isDir, force: true });
      } catch {
        // best-effort; next run will retry
      }
    }
  }
}

// Test exports.
export const __testing = { cleanupStaleTmps, isProcessAlive, STEPS: STEPS as readonly StepEntry[] };
