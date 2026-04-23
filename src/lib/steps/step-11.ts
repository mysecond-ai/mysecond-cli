// Step 11: First sync — invoke `mysecond sync --once` semantics inline by
// calling runSync. This pulls the customer's wizard-created context
// (context/company.md etc.) into the local workspace before the success box
// renders.

import { runSync } from '../../commands/sync.js';

import type { StepFn } from './types.js';

export const step11: StepFn = async ({ ctx }) => {
  // runSync returns 0 on success or throws on auth/network failure. We don't
  // bubble its non-zero exit codes back as init failures unless they're
  // MysecondErrors (those propagate via throw, not return).
  await runSync([], ctx);
  return { step: 11, outcome: { kind: 'completed' } };
};
