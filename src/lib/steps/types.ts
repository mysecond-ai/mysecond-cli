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
    // Step 15 populates from /whoami after device-code OAuth completes.
    // Used by step-13 to emit the install_completed JSON status event with
    // the customer's email in the message field.
    userEmail?: string;
    // Track T3 (Closure D2): step 15's /whoami response also surfaces team
    // membership so downstream steps can branch on invited-PM team-join.
    // - teamId / teamSlug: bound into project-scoped credentials by step-5b
    //   so the hook (T1) can verify team_mode binding rather than infer it
    //   from CLAUDE.md (P1 — Codex review).
    // - teamMembershipRole: drives the isTeamJoin decision. Anything except
    //   'owner' (and non-null) means the user is an invited PM.
    // - isTeamJoin: pre-computed by step 15 via api/whoami.ts#isTeamJoin so
    //   step-5b / step-6 / step-13 share one source of truth. When false
    //   (Solo, team owner, or whoami missing fields) all team-join writes
    //   no-op and the customer gets the existing Solo welcome.
    teamId?: string;
    teamSlug?: string;
    teamMembershipRole?: 'owner' | 'admin' | 'pm';
    isTeamJoin?: boolean;
    // Step 9 populates these from /plugin-tarball + extraction.
    pluginVersion?: string;
    pluginSha256?: string;
    // Workstream B Day 5+: sub-plugin install loop (multi-plugin PMO
    // marketplace) tracks any non-sentinel plugins whose `claude plugin
    // install` exited non-zero. Sentinel (pm-os) failure is
    // hard-fail; non-sentinel failures degrade gracefully and surface here
    // for step-13 to acknowledge in the success box.
    failedPlugins?: string[];
    // Step 9 stale-cache fallback signaling — runner uses this to print the
    // banner from §6.2.B after the success box.
    staleCacheUsed?: { cachedAgeHours: number };
    // Step 13 reads these from the extracted plugin tree (skills/, agents/,
    // commands/) and uses them in the post-install success message as proof
    // that the install actually populated content. Computed lazily in step 13
    // to avoid touching step 9's multiple LKG-fallback return paths.
    pluginCounts?: {
      skills: number;
      agents: number;
      workflows: number;
    };
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
