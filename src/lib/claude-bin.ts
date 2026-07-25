// Resolve the Claude Code `claude` CLI binary.
//
// Install + plugin registration shell out to `claude plugin …`. Bare-name PATH
// lookup (`spawnSync('claude', …)`) fails on native desktop-app Claude installs:
// `claude` is NOT on PATH there — its absolute path is exposed in the
// `$CLAUDE_CODE_EXECPATH` env var (which Claude Code sets for child processes).
// That ENOENT aborted `init` at step 9 and stranded desktop-app customers.
//
// This resolver removes the bare-name assumption. It NEVER throws — worst case
// it returns bare 'claude' (today's behavior, ENOENT handled downstream).
//
// Resolution order (each candidate validated as executable with access(X_OK) —
// existsSync is insufficient: a non-exec file would still spawn with EACCES):
//   1. $CLAUDE_CODE_EXECPATH        — the desktop signal (set inside Claude Code)
//   2. persisted last-seen path     — so a plain terminal (execpath unset) resolves
//   3. PATH walk                    — npm-CLI installs ($PATH has claude)
//   4. known native-install dirs    — desktop/native installs off PATH
//   5. fallback 'claude'            — nothing validated; preserves prior behavior
//
// $CLAUDE_CODE_EXECPATH is version-pinned (e.g. .../claude-code/2.1.156/...), so
// it dies on a Claude Code auto-update. We validate it; if it's set-but-missing
// we fire the `onExecpathStale` canary (early warning of a CC release moving the
// binary) and fall through.

import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptions } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export type ClaudeBinSource =
  | 'execpath'
  | 'persisted'
  | 'path'
  | 'known-location'
  | 'fallback';

export interface ResolvedClaudeBin {
  path: string;
  source: ClaudeBinSource;
}

export interface ResolveClaudeBinOpts {
  /** Last-seen working path persisted in sync-state (resolver step 2). */
  persistedPath?: string | null;
  /**
   * Called when CLAUDE_CODE_EXECPATH is set but does NOT point at an executable
   * — the canary for a Claude Code version bump that moved/removed the binary.
   */
  onExecpathStale?: (execpath: string) => void;
}

let cache: ResolvedClaudeBin | undefined;

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// paste-detect.ts:62 gotcha — vitest caches os.homedir() and ignores per-test
// $HOME overrides, so read process.env.HOME first for testability.
function home(): string {
  return process.env.HOME ?? homedir();
}

function pathCandidates(): string[] {
  const raw = process.env.PATH;
  if (raw === undefined || raw === '') return [];
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter((e) => e !== '')
      : [''];
  const out: string[] = [];
  for (const dir of raw.split(delimiter)) {
    if (dir === '') continue;
    for (const ext of exts) {
      out.push(join(dir, `claude${ext}`));
    }
  }
  return out;
}

function knownLocations(): string[] {
  const h = home();
  if (process.platform === 'win32') {
    const locs: string[] = [];
    const local = process.env.LOCALAPPDATA;
    if (local !== undefined && local !== '') {
      locs.push(join(local, 'Programs', 'claude', 'claude.exe'));
    }
    locs.push(join(h, '.local', 'bin', 'claude.exe'));
    return locs;
  }
  return [
    join(h, '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    join(h, '.local', 'bin', 'claude'),
  ];
}

/**
 * Resolve the `claude` CLI path. Memoized per-process (one resolution per init
 * run). Never throws.
 */
export function resolveClaudeBin(opts: ResolveClaudeBinOpts = {}): ResolvedClaudeBin {
  if (cache !== undefined) return cache;

  const execpath = process.env.CLAUDE_CODE_EXECPATH;
  if (execpath !== undefined && execpath !== '') {
    if (isExecutable(execpath)) {
      cache = { path: execpath, source: 'execpath' };
      return cache;
    }
    // Set but not executable → a CC version bump likely moved it. Canary + fall
    // through so we still resolve via PATH / known locations.
    opts.onExecpathStale?.(execpath);
  }

  const persisted = opts.persistedPath;
  if (persisted !== undefined && persisted !== null && persisted !== '' && isExecutable(persisted)) {
    cache = { path: persisted, source: 'persisted' };
    return cache;
  }

  for (const cand of pathCandidates()) {
    if (isExecutable(cand)) {
      cache = { path: cand, source: 'path' };
      return cache;
    }
  }

  for (const cand of knownLocations()) {
    if (isExecutable(cand)) {
      cache = { path: cand, source: 'known-location' };
      return cache;
    }
  }

  cache = { path: 'claude', source: 'fallback' };
  return cache;
}


// ── Spawning the claude binary (win32 triage group G, 2026-07) ──────────────
//
// Node >=18.20/20.12 (CVE-2024-27980 mitigation) throws EINVAL when
// spawnSync targets a .cmd/.bat without shell:true — and npm-shim Windows
// installs resolve `claude.cmd`. Before this helper, EVERY plugin
// register/install/uninstall spawn failed on such machines: step-9 could
// strand the install, and the prune path swallowed the EINVAL silently.
//
// With shell:true Node performs NO quoting on Windows — the command line is
// joined and handed to cmd.exe. Two defenses:
//   1. Args are quoted here when they contain spaces (marketplace dirs live
//      under paths like C:\Users\Ron Yang\...).
//   2. Args containing cmd metacharacters are REJECTED outright. Every legit
//      caller passes only validated slugs, allowlisted plugin tokens,
//      literal flags, and local paths — a metachar arg is a bug or an
//      injection attempt, never valid input.
//
// buildClaudeSpawnPlan is pure (platform injectable) so the win32 branch is
// unit-testable from any OS; spawnClaude is the thin executor every
// call site uses.

const CMD_METACHAR_RE = /[&|<>^%!"]/;

export interface ClaudeSpawnPlan {
  command: string;
  args: string[];
  shell: boolean;
}

export function buildClaudeSpawnPlan(
  claudeBin: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): ClaudeSpawnPlan {
  const needsShell = platform === 'win32' && /\.(cmd|bat)$/i.test(claudeBin);
  if (!needsShell) {
    return { command: claudeBin, args, shell: false };
  }
  for (const a of args) {
    if (CMD_METACHAR_RE.test(a)) {
      throw new Error(`refusing to shell-spawn claude with metacharacter arg: ${a}`);
    }
  }
  const quote = (v: string): string => (/[\s]/.test(v) ? `"${v}"` : v);
  return {
    command: quote(claudeBin),
    args: args.map(quote),
    shell: true,
  };
}

export function spawnClaude(
  claudeBin: string,
  args: string[],
  opts: SpawnSyncOptions,
): ReturnType<typeof spawnSync> {
  const plan = buildClaudeSpawnPlan(claudeBin, args);
  return spawnSync(plan.command, plan.args, { ...opts, shell: plan.shell });
}

export const __testing = {
  reset(): void {
    cache = undefined;
  },
};
