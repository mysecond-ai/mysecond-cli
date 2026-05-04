// Step registry — runner reads this to dispatch in order.

import { step1 } from './step-1.js';
import { step2 } from './step-2.js';
import { step3 } from './step-3.js';
import { step4 } from './step-4.js';
import { step5 } from './step-5.js';
import { step5b } from './step-5b.js';
import { step6 } from './step-6.js';
import { step7 } from './step-7.js';
import { step8 } from './step-8.js';
import { step9 } from './step-9.js';
import { step10 } from './step-10.js';
import { step11 } from './step-11.js';
import { step12 } from './step-12.js';
import { step13 } from './step-13.js';
import { step15 } from './step-15.js';

import type { StepFn } from './types.js';

export interface StepEntry {
  number: number;
  fn: StepFn;
  // Steps that mutate disk state (writes, network, child_process). Used by
  // --dry-run to decide whether to actually invoke or just log "would do".
  mutates: boolean;
  description: string;
}

export const STEPS: readonly StepEntry[] = [
  // Step 15 — device-code OAuth (Workstream B Phase 2a). Runs FIRST because
  // every downstream step relies on ctx.apiKey being populated. Numbered 15
  // out of order so the canonical 1..14 ledger identifiers stay stable for
  // existing customers (runner iterates array order, not numeric order).
  // Customers with a complete pre-WS-B ledger (1..14) re-running init will
  // skip 1..14 and run step 15 once; step 15 itself is idempotent (validates
  // existing key via /whoami, falls through to device-code only when needed).
  { number: 15, fn: step15, mutates: true, description: 'Device-code OAuth (Workstream B)' },
  { number: 1, fn: step1, mutates: false, description: 'Validate project-dir + Node version' },
  { number: 2, fn: step2, mutates: false, description: '(removed in v1.5 — placeholder)' },
  { number: 3, fn: step3, mutates: false, description: '(removed in v1.5 — placeholder)' },
  { number: 4, fn: step4, mutates: false, description: 'Poll /install-ready' },
  { number: 5, fn: step5, mutates: true,  description: 'Write .env' },
  // Step 14 (numbered out-of-order to preserve the canonical 1..13 ledger
  // identifiers — runner iterates STEPS in array order, not number order).
  // Project-scoped credential storage + .env-to-projects/<hash> migration +
  // .gitignore guard. v1.4.0 may renumber; until then the float-y position
  // here documents that this runs immediately after step 5.
  //
  // Upgrade behavior (v1.3.3 → v1.3.4): customers with a complete v1.3.3
  // ledger (steps 1..13 marked done) re-running `init` will skip 1..13 and
  // run step 14 once. Subsequent reruns no-op step 14 via its idempotency
  // checks. Counter display reads "step 14/14" because /${STEPS.length} —
  // not a bug, just slightly surprising on first reread of the runner code.
  { number: 14, fn: step5b, mutates: true, description: 'Write project-scoped credentials + gitignore guard' },
  { number: 6, fn: step6, mutates: true,  description: 'Write .claude/settings.json env block' },
  { number: 7, fn: step7, mutates: true,  description: 'Write CLAUDE.md @import block' },
  { number: 8, fn: step8, mutates: true,  description: 'Persist sync-state.json' },
  { number: 9, fn: step9, mutates: true,  description: 'Fetch + extract plugin + claude marketplace install' },
  { number: 10, fn: step10, mutates: false, description: 'Plugin-load probe (Layer 1)' },
  { number: 11, fn: step11, mutates: true,  description: 'First sync — pull context from mysecond.ai' },
  { number: 12, fn: step12, mutates: true,  description: 'Seed README.md / STRUCTURE.md / .claude/napkin.md' },
  { number: 13, fn: step13, mutates: false, description: 'Print framed success box' },
];
