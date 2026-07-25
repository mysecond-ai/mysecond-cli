// Shared Claude Code plugin-registration mechanics: `claude plugin marketplace
// remove → add → install`, run via a resolved `claude` binary under a single
// shared wall-clock budget, returning a STRUCTURED result.
//
// Used by `plugin-refresh` (the existing-customer hook-delivery path). step-9
// (FIRST install) keeps its own registration block because it is interwoven
// with init-only concerns the refresh path does not have — last-known-good
// fallback, the auth-thrash circuit breaker, the `degraded` step outcome, and
// step-timing telemetry — and because its exact source shape is pinned by the
// red-team-r2 regression tests. The two paths share the canonical path + spec
// builders in `mysecond-paths.ts` (marketplaceName / marketplaceDir /
// pluginInstallSpec / SENTINEL_PLUGIN_NAME), so the command CONTRACT (the part
// that would actually break if Claude Code changed its CLI) cannot drift; only
// the small spawn-sequencing wrapper is intentionally duplicated.

import { spawnSync } from 'node:child_process';
import { spawnClaude } from './claude-bin.js';

import {
  marketplaceDir,
  marketplaceName,
  pluginInstallSpec,
  SENTINEL_PLUGIN_NAME,
  type PluginEntry,
} from './mysecond-paths.js';

export interface RegisterParams {
  slug: string;
  /** Plugins to install (from the materialized marketplace's manifest). */
  plugins: PluginEntry[];
  /** Resolved `claude` binary path (from resolveClaudeBin). */
  claudeBin: string;
  /**
   * Absolute epoch-ms deadline. Every spawn draws from this single budget so a
   * wedged `claude` degrades fast instead of freezing — mirrors step-9's
   * REGISTER_BUDGET_MS contract.
   */
  deadlineMs: number;
  /** Pipe stdio (true) vs inherit (false, interactive). */
  silent: boolean;
}

export type RegisterOutcome =
  | { kind: 'registered' }
  | { kind: 'binary_not_found' }
  | { kind: 'timed_out' }
  | { kind: 'failed'; reason: string };

export interface RegisterResult {
  outcome: RegisterOutcome;
  /**
   * Plugins whose install exited non-zero. A non-sentinel failure is tolerated
   * (recorded here, registration still 'registered'); a sentinel (`pm-os`)
   * failure makes the outcome 'failed'.
   */
  failedPlugins: string[];
}

// spawnSync sets signal 'SIGTERM'/'SIGKILL' (status: null) when it kills a
// process that exceeded `timeout`; some platforms surface ETIMEDOUT on .error.
// (Mirror of the same predicate in step-9.ts.)
function spawnTimedOut(r: ReturnType<typeof spawnSync>): boolean {
  return (
    r.signal === 'SIGTERM' ||
    r.signal === 'SIGKILL' ||
    (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
  );
}

function isEnoent(r: ReturnType<typeof spawnSync>): boolean {
  return (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function remaining(deadlineMs: number): number {
  return deadlineMs - Date.now();
}

/**
 * Register (or re-register) the customer marketplace + install its plugins via
 * Claude Code. Idempotent: removes the marketplace first (covers a stale
 * pointer / a re-install), then adds the materialized dir, then installs each
 * plugin. The CALLER must have already materialized `marketplaceDir(slug)`
 * (fetch + extract + marketplace.json) before calling, and decides what to
 * persist from the structured result.
 *
 * Never throws — every failure mode is reported via the structured outcome so
 * a best-effort, exit-0 caller (plugin-refresh) can branch without try/catch.
 */
export function registerMarketplaceAndInstall(params: RegisterParams): RegisterResult {
  const { slug, plugins, claudeBin, deadlineMs, silent } = params;
  const failedPlugins: string[] = [];
  const stdio: 'pipe' | 'inherit' = silent ? 'pipe' : 'inherit';

  // Idempotency: remove any existing registration first (best-effort — a
  // first-time refresh has nothing to remove; a re-run clears a stale pointer).
  if (remaining(deadlineMs) <= 0) return { outcome: { kind: 'timed_out' }, failedPlugins };
  spawnClaude(
    claudeBin,
    ['plugin', 'marketplace', 'remove', marketplaceName(slug), '--scope', 'user'],
    { stdio: 'pipe', timeout: Math.max(1, remaining(deadlineMs)) }
  );

  // Add the materialized marketplace dir.
  if (remaining(deadlineMs) <= 0) return { outcome: { kind: 'timed_out' }, failedPlugins };
  const addResult = spawnClaude(
    claudeBin,
    ['plugin', 'marketplace', 'add', marketplaceDir(slug), '--scope', 'user'],
    { stdio, timeout: Math.max(1, remaining(deadlineMs)) }
  );
  if (isEnoent(addResult)) return { outcome: { kind: 'binary_not_found' }, failedPlugins };
  if (spawnTimedOut(addResult)) return { outcome: { kind: 'timed_out' }, failedPlugins };
  if (addResult.status !== 0) {
    return {
      outcome: {
        kind: 'failed',
        reason: `claude plugin marketplace add exited ${addResult.status ?? 'null'}`,
      },
      failedPlugins,
    };
  }

  // Install each plugin. Sentinel (`pm-os`) failure is fatal; others tolerated.
  for (const plugin of plugins) {
    if (remaining(deadlineMs) <= 0) return { outcome: { kind: 'timed_out' }, failedPlugins };
    const spec = pluginInstallSpec(slug, plugin.name);
    const installResult = spawnClaude(
      claudeBin,
      ['plugin', 'install', spec, '--scope', 'user'],
      { stdio, timeout: Math.max(1, remaining(deadlineMs)) }
    );
    if (isEnoent(installResult)) return { outcome: { kind: 'binary_not_found' }, failedPlugins };
    if (spawnTimedOut(installResult)) return { outcome: { kind: 'timed_out' }, failedPlugins };
    if (installResult.status !== 0) {
      failedPlugins.push(plugin.name);
      if (plugin.name === SENTINEL_PLUGIN_NAME) {
        return {
          outcome: {
            kind: 'failed',
            reason: `claude plugin install ${spec} exited ${installResult.status ?? 'null'}`,
          },
          failedPlugins,
        };
      }
    }
  }

  return { outcome: { kind: 'registered' }, failedPlugins };
}
