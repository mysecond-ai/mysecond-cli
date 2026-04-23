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
      if (isStepComplete(state, entry.number)) {
        if (!ctx.silent) {
          process.stdout.write(`step ${entry.number}/13: ${entry.description} — already done, skipping\n`);
        }
        continue;
      }

      if (ctx.dryRun && entry.mutates) {
        // --dry-run: skip mutating steps, log what would happen, never advance ledger.
        if (!ctx.silent) {
          process.stdout.write(`step ${entry.number}/13 (dry-run): would ${entry.description}\n`);
        }
        continue;
      }

      if (!ctx.silent) {
        process.stdout.write(`step ${entry.number}/13: ${entry.description}…\n`);
      }
      // RED-TEAM R2 P1-D: track current step for SIGINT telemetry above.
      currentStepNumber = entry.number;
      const result = await entry.fn(sctx);

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
      if (!ctx.dryRun) {
        markStepComplete(ctx.rootDir, state, entry.number);
      }
    }

    if (ctx.dryRun) {
      if (!ctx.silent) {
        process.stdout.write('\nDRY-RUN PASSED — would exit 0 on real run.\n');
      }
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
