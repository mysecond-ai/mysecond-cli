// Step 13: Print post-install success message (§6.8). stdout only; always runs.
// Copy redesigned May 2026 per launch-feedback-log: drop premature
// /prd-generator + /enhance-context suggestions, lead with personalized line,
// single primary CTA = `/welcome`. See `successBox()` in lib/copy.ts.
//
// Workstream B Day 5+ Item 5B: emits the `install_completed` JSON status
// event with installCompleteClaudeMessage(email) as the message field. This
// is the deferred-by-design Day 4 wiring — landed now so Claude Code Desktop's
// chat surface (when invoking via hooks/--silent) gets a deterministic
// post-install confirmation instead of paraphrasing the cli's terminal output.

import { installCompleteClaudeMessage, successBox } from '../copy.js';
import { countPluginContents } from '../plugin-counts.js';
import { pluginExtractDir } from '../mysecond-paths.js';
import { emitInstallCompleted } from '../silent-status.js';

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

  // Emit install_completed JSON status event (Item 5B). Calls
  // emitInstallCompleted (not emitStatus) so this event always reaches stdout
  // regardless of --silent mode — it is the deterministic "done" signal the
  // Claude Code Desktop chat assistant needs to stop its watcher loop.
  // The '\n\n' above (after successBox) is what separates the success box from
  // this JSON line — emitInstallCompleted does not add leading whitespace.
  // shared.userEmail is populated by step-15 from /whoami; falls back to
  // "you" if /whoami had a network error or didn't return an email field.
  emitInstallCompleted({
    kind: 'install_completed',
    message: installCompleteClaudeMessage(shared.userEmail ?? 'you'),
    skills_installed: shared.pluginCounts?.skills ?? 0,
    agents_installed: shared.pluginCounts?.agents ?? 0,
    workflows_installed: shared.pluginCounts?.workflows ?? 0,
  });

  return { step: 13, outcome: { kind: 'completed' } };
};
