// Step 2: REMOVED in v1.5 — was npmrc-token fetch + ~/.npmrc write.
// Decision 0-C eliminated GitHub Packages auth. Step 2 is now a no-op
// placeholder retained for ledger numbering stability (v1.4 step 3 used the
// same pattern).
//
// Always added to initCompletedSteps immediately on first invocation; the
// runner treats this as a free completion.

import type { StepFn } from './types.js';

export const step2: StepFn = async () => {
  return {
    step: 2,
    outcome: { kind: 'completed' },
  };
};
