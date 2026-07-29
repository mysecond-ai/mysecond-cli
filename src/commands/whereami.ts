// `mysecond whereami` — print where the current project's credentials live.
//
// Customer-empathy command per CAIO review. The new project-scoped path uses
// an opaque sha256/8 hash, which makes "where's my key?" hard to answer.
// `whereami` prints the resolved project_dir, hash, full creds path, the
// 3-tier precedence chain (matching the customer plugin hooks), and which
// source actually wins for THIS project right now.
//
// Read-only. Never modifies disk. Safe to run anywhere.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { CommandContext } from '../lib/context.js';
import {
  getGlobalCredsPath,
  getProjectScopedCredsDir,
  getProjectScopedCredsPath,
} from '../lib/creds-path.js';
import { projectHash } from '../lib/project-hash.js';

interface CredsSource {
  label: string;
  path: string;
  exists: boolean;
  hasKey: boolean;
}

const ENV_KEY = 'COMPANION_API_KEY';

function readKey(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (
        trimmed.startsWith(`${ENV_KEY}=`) ||
        trimmed.startsWith(`export ${ENV_KEY}=`)
      ) {
        const eqIdx = trimmed.indexOf('=');
        const value = trimmed
          .slice(eqIdx + 1)
          .replace(/^["']|["']$/g, '')
          .trim();
        return value.length > 0 ? value : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function maskKey(key: string | null): string {
  if (key === null) return '(none)';
  if (key.length <= 12) return key;
  return `${key.slice(0, 12)}…${key.slice(-4)}`;
}

/**
 * Redact a filesystem path so it's safe to paste in a support ticket.
 * Replaces $HOME with `~` and elides the project basename when it appears
 * to be a customer artifact (e.g. `~/Documents/clients/acme-secret-deal/`).
 *
 * Customer empathy: full absolute paths leak personal info (home dir name
 * = real name, project basename = client/project). Default-redact unless
 * `--verbose` is passed.
 */
function redactPath(absPath: string): string {
  const home = homedir();
  if (absPath.startsWith(home)) {
    return `~${absPath.slice(home.length)}`;
  }
  return absPath;
}

export async function runWhereami(
  args: readonly string[],
  ctx: CommandContext
): Promise<number> {
  const verbose = args.includes('--verbose') || args.includes('-v');
  const fmt = verbose ? (p: string): string => p : redactPath;
  const rootDir = ctx.rootDir;
  const hash = projectHash(rootDir);
  const projectScopedPath = getProjectScopedCredsPath(rootDir);
  const envPath = join(rootDir, '.env');
  const globalPath = getGlobalCredsPath();

  // Precedence (highest wins) — MUST match the customer plugin hook order
  // shipped in mysecond-ai/product-manager-os PR #13.
  const sources: CredsSource[] = [
    {
      label: '1. Project-scoped global creds (preferred)',
      path: projectScopedPath,
      exists: existsSync(projectScopedPath),
      hasKey: readKey(projectScopedPath) !== null,
    },
    {
      label: '2. Project .env (backward-compat)',
      path: envPath,
      exists: existsSync(envPath),
      hasKey: readKey(envPath) !== null,
    },
    {
      // v1.12.0: a REAL resolver source, not display-only — getDeviceToken
      // reads it as the final fallback. Written by `/mysecond` login.
      label: '3. Global creds ~/.mysecond/credentials (machine-wide fallback, written by /mysecond login)',
      path: globalPath,
      exists: existsSync(globalPath),
      hasKey: readKey(globalPath) !== null,
    },
  ];

  const winner = sources.find((s) => s.hasKey);
  const winningKey = winner === undefined ? null : readKey(winner.path);

  const out = process.stdout;
  out.write(`mysecond whereami — credential lookup for this project\n\n`);
  out.write(`project_dir : ${fmt(rootDir)}\n`);
  out.write(`hash        : ${hash}\n`);
  out.write(`creds dir   : ${fmt(getProjectScopedCredsDir(rootDir))}\n\n`);

  out.write(`Precedence chain (highest wins):\n`);
  for (const s of sources) {
    const status = s.hasKey ? '✓ has key' : s.exists ? '· file present, no key' : '· not present';
    out.write(`  ${s.label}\n`);
    out.write(`    path : ${fmt(s.path)}\n`);
    out.write(`    state: ${status}\n`);
  }

  out.write(`\nResolved key : ${maskKey(winningKey)}\n`);
  if (winner !== undefined) {
    out.write(`Source       : ${fmt(winner.path)}\n`);
  }

  if (!verbose) {
    out.write(
      `\nPaths shown with $HOME → ~ for safe-to-share output. Pass --verbose for full paths.\n`
    );
  }

  // Dual/triple-creds warning — same threat model the hook detects.
  const sourcesWithKey = sources.filter((s) => s.hasKey);
  if (sourcesWithKey.length > 1) {
    out.write(
      `\n⚠️  COMPANION_API_KEY is set in ${sourcesWithKey.length} sources. The first one above wins. ` +
        `If sync to mySecond looks wrong, remove the stale source(s).\n`
    );
  }

  // Migration nudge for install-once customers: project-scoped is missing
  // but .env has a key. They never re-ran `mysecond init` so step-5b never
  // fired the migration. Surface it here so subsequent `whereami` runs (a
  // common support-ticket flow) produce action.
  const projectScoped = sources[0];
  const envSource = sources[1];
  if (projectScoped !== undefined && envSource !== undefined &&
      !projectScoped.hasKey && envSource.hasKey) {
    out.write(
      `\n💡 Your COMPANION_API_KEY only lives in .env, which can be committed to git.\n` +
      `   Run \`mysecond init\` to migrate it into a project-scoped global file (\`${fmt(projectScoped.path)}\`).\n`
    );
  }

  if (winner === undefined) {
    out.write(
      `\nNo COMPANION_API_KEY found anywhere. Run \`mysecond init\` to set up credentials.\n`
    );
    return 1;
  }

  return 0;
}
