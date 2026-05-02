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

export async function runWhereami(
  _args: readonly string[],
  ctx: CommandContext
): Promise<number> {
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
      label: '3. Global creds ~/.mysecond/credentials (dev-only override)',
      path: globalPath,
      exists: existsSync(globalPath),
      hasKey: readKey(globalPath) !== null,
    },
  ];

  const winner = sources.find((s) => s.hasKey);
  const winningKey = winner === undefined ? null : readKey(winner.path);

  const out = process.stdout;
  out.write(`mysecond whereami — credential lookup for this project\n\n`);
  out.write(`project_dir : ${rootDir}\n`);
  out.write(`hash        : ${hash}\n`);
  out.write(`creds dir   : ${getProjectScopedCredsDir(rootDir)}\n\n`);

  out.write(`Precedence chain (highest wins):\n`);
  for (const s of sources) {
    const status = s.hasKey ? '✓ has key' : s.exists ? '· file present, no key' : '· not present';
    out.write(`  ${s.label}\n`);
    out.write(`    path : ${s.path}\n`);
    out.write(`    state: ${status}\n`);
  }

  out.write(`\nResolved key : ${maskKey(winningKey)}\n`);
  if (winner !== undefined) {
    out.write(`Source       : ${winner.path}\n`);
  }

  // Dual/triple-creds warning — same threat model the hook detects.
  const sourcesWithKey = sources.filter((s) => s.hasKey);
  if (sourcesWithKey.length > 1) {
    out.write(
      `\n⚠️  COMPANION_API_KEY is set in ${sourcesWithKey.length} sources. The first one above wins. ` +
        `If sync to mySecond looks wrong, remove the stale source(s).\n`
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
