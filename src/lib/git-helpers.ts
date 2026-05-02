// Tiny git helpers used by the credential-security guards in step-5b.
//
// Why not shell out to `git` directly? Two reasons:
//   1. Most checks are pure filesystem (`.git/` exists) — no need for git binary.
//   2. The `isFileTracked` check IS shell-dependent (we need git's view of the
//      index). We use `git ls-files --error-unmatch <file>` and treat exit 0
//      as "tracked" — this is the canonical way to detect tracked-but-edited
//      files, including ones that have since been added to .gitignore.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { atomicWriteFile } from './atomic-write.js';

/**
 * Cheap, no-shell-spawn check: is this directory inside a git repo?
 *
 * Walks up looking for a .git entry (directory in main repos, file in
 * worktrees). The 30-level cap is empirically chosen: deep monorepos
 * commonly nest 8-12 levels; 30 covers any realistic real-world depth
 * while bounding what would otherwise be unbounded I/O if the path
 * never reaches root (`parent === dir` is the canonical root sentinel
 * but is technically reachable only on POSIX). Worktrees and submodule
 * setups work because `existsSync` follows symlinks.
 *
 * Edge case: if `rootDir` is a deep subfolder of an UNRELATED parent git
 * repo (e.g. `~/Documents/somerepo/notes/myproject`), this returns true
 * for the parent's repo. Step-5b's gitignore guard will then mutate the
 * PARENT's .gitignore — usually fine but possibly surprising. Document
 * this in a `CLAUDE.md` or release note if customer reports surface.
 */
export function isGitRepo(rootDir: string): boolean {
  let dir = rootDir;
  for (let i = 0; i < 30; i++) {
    if (existsSync(join(dir, '.git'))) return true;
    const parent = join(dir, '..');
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

/**
 * Is the given path tracked by git? Returns `true` if it is, `false` if not
 * tracked OR if git is unavailable. This is the security-critical check —
 * if `.env` is already tracked, `gitignore` rules don't apply retroactively
 * and the customer's API key is in their git history.
 */
export function isFileTracked(rootDir: string, relativePath: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', relativePath], {
      cwd: rootDir,
      stdio: 'pipe', // suppress git's error output
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure `entry` is a line in `<rootDir>/.gitignore`. Creates the file if
 * missing. Returns one of: 'created', 'appended', 'already-present'.
 *
 * This is purely additive — never removes or reorders existing lines.
 */
export function ensureGitignoreEntry(
  rootDir: string,
  entry: string
): 'created' | 'appended' | 'already-present' {
  const path = join(rootDir, '.gitignore');
  if (!existsSync(path)) {
    atomicWriteFile(path, `${entry}\n`);
    return 'created';
  }
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n').map((l) => l.trim());
  if (lines.includes(entry)) return 'already-present';

  // Append to existing file. Preserve trailing newline behavior.
  const separator = raw.length === 0 || raw.endsWith('\n') ? '' : '\n';
  const next = `${raw}${separator}${entry}\n`;
  // Use direct write here (not atomicWriteFile) because .gitignore edits are
  // user-facing semantic changes and the risk of a torn write is negligible
  // for a 1-line append. atomicWriteFile is also fine, used for consistency.
  atomicWriteFile(path, next);
  return 'appended';
}
