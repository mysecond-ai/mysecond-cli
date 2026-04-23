// Wrong-window paste detection per EDD §6.9.
// Detection: $CLAUDE_PROJECT_DIR env unset AND no `.claude/` dir in CWD or any
// parent up to $HOME. Customer pasted the install command into a regular
// terminal instead of Claude Code's terminal.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function isInClaudeCodeContext(cwd: string = process.cwd()): boolean {
  // Fast path: env var set means we're already inside Claude Code.
  if (process.env.CLAUDE_PROJECT_DIR !== undefined && process.env.CLAUDE_PROJECT_DIR !== '') {
    return true;
  }

  // Walk up from cwd to $HOME looking for any `.claude/` dir.
  const home = homedir();
  let dir = cwd;
  for (let depth = 0; depth < 32; depth++) {
    if (existsSync(join(dir, '.claude'))) return true;
    if (dir === home || dir === '/' || dir === '.') break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

// CXO-7 v1.1 finalized copy. Includes Cmd+` / Ctrl+` keyboard shortcut + docs link.
export const WRONG_WINDOW_COPY = [
  'This command needs to run inside Claude Code, not a regular terminal.',
  '',
  "Open Claude Code, press Ctrl+` (or Cmd+` on Mac) to open its terminal,",
  'then paste the command there.',
  '',
  'Full walkthrough: mysecond.ai/install',
].join('\n');
