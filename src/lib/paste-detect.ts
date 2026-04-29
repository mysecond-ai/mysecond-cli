// Wrong-window paste detection per EDD §6.9.
// Detection: no Claude Code env signals AND no `.claude/` dir in CWD or any
// parent up to $HOME. Customer pasted the install command into a regular
// terminal instead of Claude Code's terminal.
//
// Claude Code bash sandbox env signals (empirically verified 2026-04-29):
//   CLAUDECODE=1               — reliably set; PRIMARY signal
//   CLAUDE_PROJECT_DIR=""      — set but to EMPTY STRING (not undefined) — do NOT use as primary
//   CLAUDE_CODE_ACCOUNT_UUID   — documented but NOT set in bash sandbox in current CC versions
//   CLAUDE_CODE_ENTRYPOINT     — set to "claude-desktop" in Desktop, varies in CLI
//
// Decision: CLAUDECODE=1 is the primary gate. The others are belt-and-suspenders.
// CLAUDE_CODE_ACCOUNT_UUID added as a future-proof check in case Anthropic starts
// setting it in the bash sandbox (per context/anthropic-tools.md it is documented
// as a valid CC env var).

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function isInClaudeCodeContext(cwd: string = process.cwd()): boolean {
  // Primary: CLAUDECODE=1 — reliably set in CC's bash sandbox across all versions.
  // This is the only signal that is (a) non-empty and (b) consistently present.
  if (process.env.CLAUDECODE === '1') {
    return true;
  }

  // Belt-and-suspenders: CLAUDE_CODE_ACCOUNT_UUID — documented as a CC env var
  // (context/anthropic-tools.md). Not currently set in bash sandbox but may be
  // in future CC versions or in non-bash execution contexts.
  if (process.env.CLAUDE_CODE_ACCOUNT_UUID !== undefined && process.env.CLAUDE_CODE_ACCOUNT_UUID !== '') {
    return true;
  }

  // Belt-and-suspenders: CLAUDE_CODE_ENTRYPOINT — set by CC Desktop/CLI to
  // "claude-desktop" or similar. Not set in regular terminals.
  if (process.env.CLAUDE_CODE_ENTRYPOINT !== undefined && process.env.CLAUDE_CODE_ENTRYPOINT !== '') {
    return true;
  }

  // Secondary: CLAUDE_PROJECT_DIR set to a non-empty path.
  // Note: CC sandbox sets this to "" (empty string), so empty string is NOT
  // a valid signal — must check for non-empty explicitly.
  if (process.env.CLAUDE_PROJECT_DIR !== undefined && process.env.CLAUDE_PROJECT_DIR !== '') {
    return true;
  }

  // Walk up from cwd to (but NOT including) $HOME looking for any `.claude/` dir.
  //
  // RED-TEAM P0-3: previously this loop checked existsSync BEFORE the
  // break-at-home check, so when the walk reached $HOME it found `~/.claude/`
  // (Claude Code Desktop's install dir) and returned true. That defeated the
  // wrong-window check unconditionally for every Mac user with Claude Code
  // installed — i.e., the entire customer base. Now we break at $HOME WITHOUT
  // checking it, so only project-level `.claude/` dirs count as evidence of
  // a Claude Code workspace.
  //
  // We resolve home by checking $HOME first (so tests can override via env)
  // then falling back to homedir(). Vitest's module loader caches the result
  // of `os.homedir()` in a way that ignores per-test env overrides, so reading
  // process.env.HOME directly is the only reliable way to make this testable.
  const home = process.env.HOME ?? homedir();
  let dir = cwd;
  for (let depth = 0; depth < 32; depth++) {
    // Stop BEFORE checking $HOME: the user's `~/.claude/` install dir is not
    // a Claude Code project marker.
    if (dir === home || dir === '/' || dir === '.') break;
    if (existsSync(join(dir, '.claude'))) return true;
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
