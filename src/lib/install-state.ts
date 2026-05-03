// Install state — `~/.mysecond/projects/<hash>/install-state.json`.
//
// Workstream H: tracks the install-time SHA of every base plugin file the cli
// has written into <project>/{.claude/skills,.claude/agents,workflows}/. On
// every `mysecond sync`, we compare the local file's current SHA to the
// recorded install-time SHA. If they match → the customer hasn't touched the
// file → safe to overwrite with the latest base content. If they differ →
// the customer customized the file → SKIP overwrite silently (per locked
// product decision: customizations are invisible to mySecond).
//
// Format:
//   {
//     "base_plugin_version": "<40-char-hex-sha or null>",
//     "files": {
//       ".claude/skills/prd-generator/SKILL.md": "<sha-when-we-wrote-it>",
//       ".claude/agents/cto.md": "<sha-when-we-wrote-it>",
//       ...
//     }
//   }
//
// Hash format: 12-char short sha (matches mysecond-cli `shortHash` and
// mysecond-app `shortHash` so server-supplied current_hash values are
// directly comparable without re-hashing).
//
// Atomic write via the same atomicWriteFile helper used by sync-state.json.
// Soft-fail reads — if the JSON is corrupted, return a fresh empty state and
// let the next sync re-hydrate; better than crashing the SessionStart hook.

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { atomicWriteFile } from './atomic-write.js';
import { getProjectScopedCredsDir } from './creds-path.js';
import { join } from 'node:path';

export interface InstallState {
  /** Current SHA the customer is "installed at" — null until first base sync. */
  base_plugin_version: string | null;
  /** project-relative file_path → 12-char shortHash recorded when we last wrote it. */
  files: Record<string, string>;
}

function freshState(): InstallState {
  return { base_plugin_version: null, files: {} };
}

function installStatePath(absoluteProjectDir: string): string {
  return join(getProjectScopedCredsDir(absoluteProjectDir), 'install-state.json');
}

export function readInstallState(absoluteProjectDir: string): InstallState {
  const path = installStatePath(absoluteProjectDir);
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<InstallState>;
    return {
      base_plugin_version:
        typeof parsed.base_plugin_version === 'string' ? parsed.base_plugin_version : null,
      files:
        parsed.files && typeof parsed.files === 'object'
          ? Object.fromEntries(
              Object.entries(parsed.files).filter(
                ([, v]) => typeof v === 'string',
              ) as Array<[string, string]>,
            )
          : {},
    };
  } catch {
    return freshState();
  }
}

export function writeInstallState(absoluteProjectDir: string, state: InstallState): void {
  const path = installStatePath(absoluteProjectDir);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFile(path, JSON.stringify(state, null, 2) + '\n');
}

/** Test-friendly alias — returns the canonical install-state path. */
export function getInstallStatePath(absoluteProjectDir: string): string {
  return installStatePath(absoluteProjectDir);
}
