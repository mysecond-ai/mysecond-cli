// Step 6: Ensure the mySecond-managed `.claude/settings.json` surface — the env
// block (SLASH_COMMAND_TOOL_CHAR_BUDGET) AND the usage-tracking `UserPromptSubmit`
// hook. Both are owned by `ensureCompanionHooks` (one strict-parse, locked,
// fail-closed read-modify-write), so init never routes settings.json through a
// lenient reader that could clobber a corrupt-but-present file (Codex P0-2).
//
// History: hooks used to live here, were moved to the plugin manifest (CAIO-Y1,
// v1.3) — which silently broke delivery because plugin-delivered hooks don't fire
// in Claude Code — and are now re-injected here. Full root-cause writeup in
// `companion-hooks.ts`.

import { ensureCompanionHooks } from '../companion-hooks.js';

import type { StepFn } from './types.js';

export const step6: StepFn = async ({ ctx }) => {
  await ensureCompanionHooks(ctx.rootDir, { silent: ctx.silent });
  return { step: 6, outcome: { kind: 'completed' } };
};
