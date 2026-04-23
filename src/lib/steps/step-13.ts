// Step 13: Print framed success box (§6.8). stdout only; always runs.
// Box copy is finalized per Ron-B1 v2 + v1.4 restart instruction.

import { successBox } from '../copy.js';

import type { StepFn } from './types.js';

export const step13: StepFn = async ({ ctx, shared }) => {
  // RED-TEAM R2 P0-A: pmName + companyName are SEPARATE shared fields. v1.4
  // conflated them under shared.customerName which produced "for [PM] at [PM]"
  // for every customer on launch day. See step 4 for the population logic.
  const pmName = shared.pmName ?? 'you';
  const companyName = shared.companyName ?? 'your company';
  if (!ctx.silent) {
    process.stdout.write('\n' + successBox(pmName, companyName) + '\n\n');
  }
  return { step: 13, outcome: { kind: 'completed' } };
};
