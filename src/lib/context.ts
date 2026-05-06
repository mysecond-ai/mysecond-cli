// CommandContext — runtime context built once in main() and threaded through
// every subcommand.

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { MysecondError } from './errors.js';

export type ConflictStrategy = 'prompt' | 'cloud-wins' | 'local-wins' | 'skip';

export interface CommandContext {
  apiBase: string;
  apiKey: string;
  rootDir: string;
  silent: boolean;
  dryRun: boolean;
  forceUpdate: boolean;
  fix: boolean;
  strategy: ConflictStrategy;
  /**
   * `mysecond init --resume` (Workstream B Phase 2a). When set, init re-runs
   * the device-code OAuth step even if its ledger entry is marked complete,
   * picking up an interrupted authorization. Other completed steps are still
   * skipped; only the device-code step's idempotency is overridden.
   */
  resume: boolean;
  /**
   * `mysecond init --auth-only` (v1.4.2). Mints a device code, persists
   * pending-auth state, and exits ~5s. Pairs with a follow-up
   * `mysecond init --resume` to finish install. Two-command flow exists
   * because Claude Code Desktop's bash tool buffers single-command stdout
   * until completion, so a 9-minute single-command flow never surfaces
   * the auth code to the agent.
   */
  authOnly: boolean;
}

export interface ParsedFlags {
  apiKey: string | null;
  projectDir: string | null;
  silent: boolean;
  dryRun: boolean;
  forceUpdate: boolean;
  fix: boolean;
  resume: boolean;
  authOnly: boolean;
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
    fix: false,
    resume: false,
    authOnly: false,
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
    } else if (arg === '--fix') {
      out.fix = true;
    } else if (arg === '--resume') {
      out.resume = true;
    } else if (arg === '--auth-only') {
      out.authOnly = true;
    } else if (arg === '--api-key') {
      const next = args[i + 1];
      if (next === undefined) throw MysecondError.invalidFlag('--api-key', 'requires a value');
      out.apiKey = next;
      i++;
    } else if (arg === '--project-dir') {
      const next = args[i + 1];
      if (next === undefined) throw MysecondError.invalidFlag('--project-dir', 'requires a value');
      out.projectDir = next;
      i++;
    } else if (arg === '--strategy') {
      const next = args[i + 1];
      if (next === undefined) throw MysecondError.invalidFlag('--strategy', 'requires a value');
      if (!STRATEGIES.has(next)) {
        throw MysecondError.invalidFlag(
          '--strategy',
          `must be one of: prompt, cloud-wins, local-wins, skip (got '${next}')`
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

  // Codex P0-1: load device token from keychain at context-build time.
  // The previous design read the token in step 15, but the runner skips
  // completed steps on re-run — so once step 15 was marked done, ctx.apiKey
  // would be empty on subsequent inits and step 4 (/install-ready) would
  // 401. Sourcing here makes idempotent re-runs work correctly:
  //   precedence: --api-key flag > COMPANION_API_KEY env > keychain/file
  let apiKey = flags.apiKey ?? process.env.COMPANION_API_KEY ?? '';
  if (apiKey.length === 0) {
    try {
      // Lazy import to keep `mysecond --version` and `mysecond --help` fast
      // (they don't need credentials).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getDeviceToken } = require('./keychain.js') as typeof import('./keychain.js');
      const fromStorage = getDeviceToken(rootDir);
      if (fromStorage !== null) apiKey = fromStorage.token;
    } catch {
      // Best-effort. If keychain lookup throws, fall through to empty
      // apiKey; step 15 will run the device-code flow.
    }
  }

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
    fix: flags.fix,
    resume: flags.resume,
    authOnly: flags.authOnly,
    strategy,
  };
}
