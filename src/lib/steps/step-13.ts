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

  // Did the plugin actually REGISTER with Claude Code? Step 9 sets this false
  // when its degradable registration phase failed (binary unresolvable, timeout,
  // non-zero exit). countPluginContents() reads the EXTRACTED tarball — and
  // extraction is NOT registration, so on a degraded install those counts would
  // claim skills that aren't actually loadable. Gate everything on registration.
  const registered = shared.pluginRegistered ?? true;

  // Count installed skills/agents/workflows from the extracted plugin tree as
  // proof the install populated content. Only meaningful when registered.
  if (registered && shared.pluginCounts === undefined && shared.customerSlug !== undefined) {
    shared.pluginCounts = countPluginContents(pluginExtractDir(shared.customerSlug));
  }

  if (!ctx.silent) {
    if (registered) {
      process.stdout.write('\n' + successBox(pmName, companyName, shared.pluginCounts, shared.isInvitedPm ?? false) + '\n\n');
    } else {
      // Degraded: be honest. Context synced, skills did not finish installing.
      process.stdout.write(
        `\nYour context for ${companyName} synced successfully — but the PM OS skills didn't finish installing in this session.\n` +
          `To finish loading them, re-open Claude Code (or re-run the install command). Your data is safe and already synced.\n\n`,
      );
    }
  }

  // Emit install_completed JSON status event (Item 5B). Always reaches stdout
  // (even --silent) — the deterministic "done" signal the Claude Code Desktop
  // chat watcher needs to stop its loop. We keep kind='install_completed' so an
  // existing watcher still stops, but carry plugin_registered/context_synced so
  // it (and the web app) can distinguish a full install from a degraded one and
  // never claim skills are ready when they aren't. skills counts are zeroed when
  // registration degraded (extraction != registration).
  emitInstallCompleted({
    kind: 'install_completed',
    message: registered
      ? installCompleteClaudeMessage(shared.userEmail ?? 'you')
      : `Context synced for ${shared.userEmail ?? 'you'}, but the PM OS skills didn't finish installing — re-open Claude Code (or re-run the install) to finish.`,
    context_synced: true,
    plugin_registered: registered,
    skills_installed: registered ? (shared.pluginCounts?.skills ?? 0) : 0,
    agents_installed: registered ? (shared.pluginCounts?.agents ?? 0) : 0,
    workflows_installed: registered ? (shared.pluginCounts?.workflows ?? 0) : 0,
    ...(registered ? {} : { registration_degraded_reason: shared.registrationDegradedReason ?? 'unknown' }),
  });

  return { step: 13, outcome: { kind: 'completed' } };
};
