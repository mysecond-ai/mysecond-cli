// Step 8: Initial `.claude/sync-state.json` write.
// State already mutated in earlier steps (customerId, customerSlug,
// workspaceScope from step 4). Step 8 just persists current shape so the
// ledger is on disk before step 9 starts mutating files outside the project
// dir (~/.mysecond/...).

import { writeSyncState } from '../sync-state.js';

import type { StepFn } from './types.js';

export const step8: StepFn = async ({ ctx, state }) => {
  writeSyncState(ctx.rootDir, state);
  return { step: 8, outcome: { kind: 'completed' } };
};
