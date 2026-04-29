// Step 3: REMOVED in v1.5 — was the API-key/subscription validation gate
// (CTO-v1.2-Y2 already collapsed step 3 into step 2 in v1.4). With step 2
// also collapsed in v1.5, step 3 stays a no-op placeholder. Auth gate now
// lives at step 9 sub-step (a) signed-URL fetch.

import type { StepFn } from './types.js';

export const step3: StepFn = async () => {
  return {
    step: 3,
    outcome: { kind: 'completed' },
  };
};
