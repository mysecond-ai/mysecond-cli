// Atomic file/dir writes — temp + rename pattern. Used by every step that
// mutates filesystem state (steps 5/6/7/8/9/12) so a SIGINT mid-write leaves
// a stale tmp the resume cleanup can detect+unlink (§6.7), never a half-written
// final file. Cross-platform per Decision 0-C guardrail #4 — no shell calls.
//
// Test harness shim: `__injectableDelayBetweenRenames` lets tests deterministically
// kill the process between coupled renames (§6.10 v1.1 blocker-coverage row).
// Test-env only — production path is a no-op.

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Test-only injection point. Production callers never set this.
export let __injectableDelayBetweenRenames: number = 0;
export function __setInjectableDelayBetweenRenames(ms: number): void {
  __injectableDelayBetweenRenames = ms;
}

function tmpSuffix(pid: number = process.pid): string {
  return `.tmp-${pid}`;
}

// Write a file atomically: write to `path.tmp-{pid}`, then rename to final path.
// Caller must ensure the destination dir exists (or pass mkdirRecursive: true).
export function atomicWriteFile(
  path: string,
  content: string,
  opts: { mode?: number; mkdirRecursive?: boolean } = {}
): void {
  if (opts.mkdirRecursive) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const tmp = path + tmpSuffix();
  const writeOpts: { mode?: number } = {};
  if (opts.mode !== undefined) writeOpts.mode = opts.mode;
  writeFileSync(tmp, content, writeOpts);
  renameSync(tmp, path);
}

// Atomically rename a directory (works cross-platform when destination is
// either non-existent OR an empty dir). For non-empty destinations, caller must
// `rmDirRecursive(destination)` first — `fs.renameSync` is NOT cross-platform
// safe across platforms when destination is a non-empty dir (CTO P1-2 in v1.5
// review). Used by step 9 sub-step (e) to swap `.tmp-{pid}/` into final.
export function atomicRenameDir(tmpDir: string, finalDir: string): void {
  // CTO P1-2 fix: explicitly remove non-empty destination first to handle the
  // re-run / idempotency case. Linux atomically replaces empty dirs only;
  // macOS fails with ENOTEMPTY on non-empty destinations. Two-step delete +
  // rename is the only cross-platform safe path. Acceptable race: another
  // process can't be writing here because caller holds marketplace-lock.
  rmDirRecursive(finalDir);
  renameSync(tmpDir, finalDir);
}

export function rmDirRecursive(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

// Coupled-rename pattern (HoD-1 in v1.1) — write two tmps, rename both. Tests
// can inject delay between the renames to simulate kill -9 mid-sequence.
export function coupledAtomicWrite(
  writes: ReadonlyArray<{ path: string; content: string; mode?: number }>
): void {
  const tmps = writes.map((w) => {
    const tmpPath = w.path + tmpSuffix();
    const writeOpts: { mode?: number } = {};
    if (w.mode !== undefined) writeOpts.mode = w.mode;
    mkdirSync(dirname(w.path), { recursive: true });
    writeFileSync(tmpPath, w.content, writeOpts);
    return { tmpPath, finalPath: w.path };
  });
  for (let i = 0; i < tmps.length; i++) {
    const t = tmps[i];
    if (t === undefined) continue;
    renameSync(t.tmpPath, t.finalPath);
    if (
      __injectableDelayBetweenRenames > 0 &&
      i < tmps.length - 1
    ) {
      // Spin-wait — Atomics.wait would be cleaner but only in worker context.
      const until = Date.now() + __injectableDelayBetweenRenames;
      while (Date.now() < until) {
        // intentional busy-wait for test determinism
      }
    }
  }
}
