// Step 13: Print post-install success message (§6.8). stdout only; always runs.
// Copy redesigned May 2026 per launch-feedback-log: drop premature
// /prd-generator + /enhance-context suggestions, lead with personalized line,
// single primary CTA = `/welcome`. See `successBox()` in lib/copy.ts.

import { successBox } from '../copy.js';
import { countPluginContents } from '../plugin-counts.js';
import { pluginExtractDir } from '../mysecond-paths.js';

import type { StepFn } from './types.js';

export const step13: StepFn = async ({ ctx, shared }) => {
  // RED-TEAM R2 P0-A: pmName + companyName are SEPARATE shared fields. v1.4
  // conflated them under shared.customerName which produced "for [PM] at [PM]"
  // for every customer on launch day. See step 4 for the population logic.
  const pmName = shared.pmName ?? 'you';
  const companyName = shared.companyName ?? 'your company';

  // Count installed skills/agents/workflows from the extracted plugin tree as
  // proof the install populated content. Best-effort: if the slug is missing
  // or the extract dir is unreadable, counts default to all-zero and the
  // success copy degrades to a generic "PM skill library" phrase.
  if (shared.pluginCounts === undefined && shared.customerSlug !== undefined) {
    shared.pluginCounts = countPluginContents(pluginExtractDir(shared.customerSlug));
  }

  if (!ctx.silent) {
    process.stdout.write('\n' + successBox(pmName, companyName, shared.pluginCounts) + '\n\n');
  }
  return { step: 13, outcome: { kind: 'completed' } };
};
