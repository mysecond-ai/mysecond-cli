// Step 11: First sync — invoke `mysecond sync --once` semantics inline by
// calling runSync. This pulls the customer's wizard-created context
// (context/company.md etc.) into the local workspace before the success box
// renders.

import { runSync } from '../../commands/sync.js';
import { MysecondError } from '../errors.js';

import type { StepFn } from './types.js';

export const step11: StepFn = async ({ ctx }) => {
  // RED-TEAM P1-1: runSync today always returns 0 or throws, but the contract
  // is `Promise<number>`. Future runSync code paths could return non-zero
  // without throwing (e.g., conflict-resolution mode "skip" that resolves
  // gracefully but indicates partial-success). We defensively check the
  // return value so step 11 can't silently advance the ledger while sync
  // half-failed — which would render the success box over an empty context dir.
  const exit = await runSync([], ctx);
  if (exit !== 0) {
    throw new MysecondError(
      Number.isFinite(exit) && exit > 0 && exit < 130 ? (exit as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8) : 1,
      `First sync returned exit ${exit}. Re-run \`mysecond sync\` to retry, or contact support@mysecond.ai.`
    );
  }
  return { step: 11, outcome: { kind: 'completed' } };
};
