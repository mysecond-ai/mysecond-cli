// Shared types for the 13 init steps.
// Each step is `(ctx, state) => Promise<StepResult>`. The runner threads
// CommandContext + mutable SyncState through them and persists the ledger
// after each successful step.

import type { CommandContext } from '../context.js';
import type { SyncState } from '../sync-state.js';

export interface StepContext {
  ctx: CommandContext;
  state: SyncState;
  // Shared state populated by earlier steps. Steps read what they need; the
  // shape grows as steps add data. Optional fields are normalized at the
  // first step that depends on them (early steps fail fast if missing).
  shared: {
    // Step 4 populates these from /install-ready response.
    customerId?: string;
    // RED-TEAM R2 P0-A: pmName + companyName MUST be separate fields. The
    // first version of this code conflated them under `customerName`, which
    // produced "for [PM] at [PM]" in the success box for every customer.
    pmName?: string;
    companyName?: string;
    customerSlug?: string;
    workspaceScope?: 'solo' | 'team';
    // Step 9 populates these from /plugin-tarball + extraction.
    pluginVersion?: string;
    pluginSha256?: string;
    // Step 9 stale-cache fallback signaling — runner uses this to print the
    // banner from §6.2.B after the success box.
    staleCacheUsed?: { cachedAgeHours: number };
  };
}

export type StepOutcome =
  | { kind: 'completed' }                                       // step ran (or was already complete)
  | { kind: 'skipped'; reason: string }                          // intentionally skipped (--dry-run)
  | { kind: 'aborted'; reason: string };                         // step decided to halt the whole init w/o throwing

export interface StepResult {
  step: number;
  outcome: StepOutcome;
  // Optional stdout message the runner should print between steps.
  message?: string;
}

export type StepFn = (sctx: StepContext) => Promise<StepResult>;
