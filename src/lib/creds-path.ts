// Credential path resolution — single source of truth so a future Anthropic
// `$CLAUDE_PLUGIN_DATA_DIR` (or similar) is a one-line swap rather than a
// hunt across call sites. Per CAIO review (2026-05-02): centralize the path,
// not just the hash.
//
// Today's behavior: returns `~/.mysecond/projects/<projectHash>/credentials`.
// We deliberately do NOT pre-read `$CLAUDE_PLUGIN_DATA_DIR` — that env var
// has no published Anthropic convention as of this writing, and inventing a
// contract risks breaking when the real one ships. When/if it lands, swap
// the base path here and downstream callers Just Work.

import { homedir } from 'node:os';
import { join } from 'node:path';

import { projectHash } from './project-hash.js';

/** Project-scoped credentials FILE. */
export function getProjectScopedCredsPath(absoluteProjectDir: string): string {
  return join(getProjectScopedCredsDir(absoluteProjectDir), 'credentials');
}

/** Project-scoped credentials DIRECTORY (parent of the file). */
export function getProjectScopedCredsDir(absoluteProjectDir: string): string {
  return join(homedir(), '.mysecond', 'projects', projectHash(absoluteProjectDir));
}

/** Global (dev-only) credentials file — for `whereami` precedence display. */
export function getGlobalCredsPath(): string {
  return join(homedir(), '.mysecond', 'credentials');
}
