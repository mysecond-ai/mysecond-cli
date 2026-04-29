// `mysecond init` — install the PM OS into the current Claude Code workspace.
// Implements EDD §6: 13 atomic, idempotent, resumable steps.

import type { CommandContext } from '../lib/context.js';
import { runInit as runInitInternal } from '../lib/init-runner.js';

export async function runInit(_args: readonly string[], ctx: CommandContext): Promise<number> {
  return runInitInternal(ctx);
}
