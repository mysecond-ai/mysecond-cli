// CommandContext — runtime context built once in main() and threaded through every
// subcommand. Centralizes config resolution so subcommands don't re-parse env vars,
// re-read .env files, or re-derive paths.
//
// Per EDD-solo-phase-4-pmkit-cli.md §5 + CTO PR 4a forward-work item #1.

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export type ConflictStrategy = 'prompt' | 'cloud-wins' | 'local-wins' | 'skip';

export interface CommandContext {
  apiBase: string;
  apiKey: string;
  rootDir: string;
  silent: boolean;
  dryRun: boolean;
  forceUpdate: boolean;
  strategy: ConflictStrategy;
}

export interface ParsedFlags {
  apiKey: string | null;
  projectDir: string | null;
  silent: boolean;
  dryRun: boolean;
  forceUpdate: boolean;
  strategy: ConflictStrategy | null;
  positional: string[];
}

const STRATEGIES: ReadonlySet<string> = new Set(['prompt', 'cloud-wins', 'local-wins', 'skip']);

export function parseGlobalFlags(args: readonly string[]): ParsedFlags {
  const out: ParsedFlags = {
    apiKey: null,
    projectDir: null,
    silent: false,
    dryRun: false,
    forceUpdate: false,
    strategy: null,
    positional: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--silent') {
      out.silent = true;
    } else if (arg === '--dry-run') {
      out.dryRun = true;
    } else if (arg === '--force-update') {
      out.forceUpdate = true;
    } else if (arg === '--api-key') {
      const next = args[i + 1];
      if (next === undefined) throw new Error('--api-key requires a value');
      out.apiKey = next;
      i++;
    } else if (arg === '--project-dir') {
      const next = args[i + 1];
      if (next === undefined) throw new Error('--project-dir requires a value');
      out.projectDir = next;
      i++;
    } else if (arg === '--strategy') {
      const next = args[i + 1];
      if (next === undefined) throw new Error('--strategy requires a value');
      if (!STRATEGIES.has(next)) {
        throw new Error(
          `--strategy must be one of: prompt, cloud-wins, local-wins, skip (got '${next}')`
        );
      }
      out.strategy = next as ConflictStrategy;
      i++;
    } else if (arg !== undefined) {
      out.positional.push(arg);
    }
  }

  return out;
}

// Loads .env from the project dir into process.env (without dotenv dep).
// Existing process.env entries take precedence — matches legacy sync-context.js behavior.
function loadDotenv(rootDir: string): void {
  const envPath = resolve(rootDir, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).replace(/^export\s+/, '').trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

export function buildContext(flags: ParsedFlags): CommandContext {
  // Resolve rootDir BEFORE loading .env (so we know where to look for .env).
  // Precedence: --project-dir flag > $CLAUDE_PROJECT_DIR env > cwd().
  const rawRoot = flags.projectDir ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const rootDir = isAbsolute(rawRoot) ? rawRoot : resolve(process.cwd(), rawRoot);

  loadDotenv(rootDir);

  const apiBase = process.env.COMPANION_API_URL ?? 'https://app.mysecond.ai';
  const apiKey = flags.apiKey ?? process.env.COMPANION_API_KEY ?? '';

  // Strategy default: prompt if interactive (TTY) and not silent; cloud-wins otherwise.
  // CXO call (PR 4b design): keep customer in control where possible, default to safe
  // auto-resolve in non-interactive surfaces (Claude Code chat hooks, CI, --silent).
  const isInteractive = Boolean(process.stdin.isTTY) && !flags.silent;
  const strategy: ConflictStrategy = flags.strategy ?? (isInteractive ? 'prompt' : 'cloud-wins');

  return {
    apiBase,
    apiKey,
    rootDir,
    silent: flags.silent,
    dryRun: flags.dryRun,
    forceUpdate: flags.forceUpdate,
    strategy,
  };
}
