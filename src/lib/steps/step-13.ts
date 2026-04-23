// Step 13: Print framed success box (§6.8). stdout only; always runs.
// Box copy is finalized per Ron-B1 v2 + v1.4 restart instruction.

import { successBox } from '../copy.js';

import type { StepFn } from './types.js';

export const step13: StepFn = async ({ ctx, shared }) => {
  const pmName = shared.customerName ?? 'you';
  const companyName = shared.customerName ?? 'your company';
  if (!ctx.silent) {
    process.stdout.write('\n' + successBox(pmName, companyName) + '\n\n');
  }
  return { step: 13, outcome: { kind: 'completed' } };
};
