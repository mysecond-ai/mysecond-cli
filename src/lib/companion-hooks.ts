// companion-hooks — the SINGLE owner of every mySecond-managed mutation to a
// project's `.claude/settings.json`: the env block (SLASH_COMMAND_TOOL_CHAR_BUDGET)
// AND the usage-tracking `UserPromptSubmit` hook. One locked, strict-parse,
// fail-closed, stable-marker read-modify-write.
//
// WHY THIS EXISTS (root cause). Usage hooks were moved OUT of `.claude/settings.json`
// and INTO the plugin manifest (decision CAIO-Y1, v1.3) — but plugin-delivered
// hooks do NOT fire in Claude Code (empirically A/B tested 2026-06-06: a hook in
// `~/.claude/settings.json` fired + posted a real event; the same hook in the
// plugin's `hooks/hooks.json` fired nothing). Corroborating open CC issues:
// #10225 (plugin UserPromptSubmit "match but never execute"), #29767 (plugin Stop
// never fires while SessionStart does). `settings.json` hooks DO fire, so the CLI
// re-injects the emit hook here. (Reverts CAIO-Y1 for the emit hook only.)
//
// We register `UserPromptSubmit` (typed slash commands → skill_run/workflow_run)
// AND `SubagentStop` (sub-agent completions → subagent_run) — one command for both;
// emit-event dispatches on the hook_event_name it reads on stdin. NOT
// `PostToolUse:"Skill"` (the Skill tool is a prompt-expansion that dispatches no
// PostToolUse event — confirmed no-op, CC issue #43630). NOT `UserPromptExpansion`
// (a typed slash command fires BOTH it and `UserPromptSubmit`; emit-event would
// record one row for each with distinct synthetic ids the server dedup can't
// collapse → double-count). `SubagentStop` carries the sub-agent's type as a
// TOP-LEVEL `agent_type` (per code.claude.com/docs/en/sub-agents); emit-event reads
// that — NOT the old `tool_input.subagent_type` guess that silently emitted nothing.
//
// Reviewed CTO + CAIO + Codex (2026-06-06). Codex P0s folded:
//   P0-1  buffer + replay stdin in the command: a stale global `mysecond` that
//         starts, drains the event JSON off stdin, then exits non-zero would leave
//         the npx fallback reading EMPTY stdin (useless exactly when it fires). We
//         buffer once (`json=$(cat)`) and replay the SAME bytes to whichever arm
//         runs. `&& exit 0` takes the global arm only on success; otherwise the
//         pinned npx arm runs with the replayed stdin.
//   P0-2  strict parse + write-nothing-on-error: this helper OWNS the env write too,
//         so init no longer routes through a lenient reader that would erase a
//         corrupt-but-present settings.json before we ran.
//   P0-3  STABLE version-independent marker (`# mysecond-companion-usage-hook`): a
//         version bump REPLACES our hook in place instead of appending a second one
//         (the exact command string can't be the marker — it carries the version).

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import lockfile from 'proper-lockfile';

import { atomicWriteFile } from './atomic-write.js';
import { projectPaths } from './files.js';

// esbuild injects __VERSION__ at build time; vitest defines it from package.json.
declare const __VERSION__: string;

// Env block — was step-6's sole job; now owned here so one strict reader guards
// the whole file (Codex P0-2).
const ENV_KEY = 'SLASH_COMMAND_TOOL_CHAR_BUDGET';
const ENV_VALUE = '20000';

// Stable, VERSION-INDEPENDENT marker carried as a trailing shell comment in the
// injected command. The injector finds OUR hook by this substring (never the exact
// command string, which carries the version) so a version bump replaces in place
// instead of appending a duplicate (Codex P0-3).
export const HOOK_MARKER = 'mysecond-companion-usage-hook';

// UserPromptSubmit is SYNCHRONOUS and BLOCKS the prompt (default 30s — per
// code.claude.com/docs/en/hooks). Cap our hook at 8s so a cold-npx spawn can never
// inherit the 30s block.
const HOOK_TIMEOUT = 8;

// Lock tuning — mirror sync-state.ts / marketplace-lock proven values.
const LOCK_STALE_MS = 30_000;
const LOCK_RETRIES = 5;
const LOCK_MIN_TIMEOUT_MS = 100;

interface SettingsShape {
  env?: unknown;
  hooks?: unknown;
  [key: string]: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// The injected UserPromptSubmit command. Buffers stdin once, tries a global
// `mysecond` of the running version, and on ANY miss/failure replays the SAME
// buffered stdin to a version-pinned npx fallback. (Codex P0-1.) `<version>` pins
// the npx arm so it doesn't hit the registry for @latest and is reproducible. The
// trailing `# <marker>` is the stable idempotency marker (Codex P0-3). Exported
// for tests.
export function buildHookCommand(version: string): string {
  return (
    `bash -lc 'json=$(cat); ` +
    `printf "%s" "$json" | mysecond emit-event --silent 2>/dev/null && exit 0; ` +
    `printf "%s" "$json" | npx -y @mysecond/cli@${version} emit-event --silent 2>/dev/null || true` +
    `  # ${HOOK_MARKER}'`
  );
}

export type PlanResult =
  | { action: 'write'; next: SettingsShape }
  | { action: 'noop' }
  | { action: 'skip'; reason: 'not-an-object' };

// Pure merge — no IO, no lock. Given the parsed settings object + the version to
// pin, returns the next settings object (or noop/skip). Exported for unit tests so
// every merge case is covered without touching disk.
export function planCompanionSettings(
  current: unknown,
  version: string,
  silent = false
): PlanResult {
  if (!isPlainObject(current)) {
    // Root isn't a JSON object — never clobber it (Codex P0-2 / fail-closed).
    return { action: 'skip', reason: 'not-an-object' };
  }

  // Deep clone so we never mutate the caller's parsed object (plain JSON in).
  const next = JSON.parse(JSON.stringify(current)) as SettingsShape;
  let changed = false;

  if (mergeEnvBlock(next, silent)) changed = true;
  // One command, two hook events: UserPromptSubmit captures typed slash commands
  // (skill_run / workflow_run); SubagentStop captures sub-agent completions
  // (subagent_run). emit-event dispatches on the hook_event_name it reads on stdin.
  const command = buildHookCommand(version);
  if (mergeEventHook(next, 'UserPromptSubmit', command, silent)) changed = true;
  if (mergeEventHook(next, 'SubagentStop', command, silent)) changed = true;

  return changed ? { action: 'write', next } : { action: 'noop' };
}

// Env block merge. Absent → set. Present + plain object → ensure our key
// (customer-authored different value WINS, per the original step-6 §6.3a rule).
// Present but NOT a plain object → fail closed (skip, never clobber). Returns true
// if it changed `next`.
function mergeEnvBlock(next: SettingsShape, silent: boolean): boolean {
  if (next.env === undefined) {
    next.env = { [ENV_KEY]: ENV_VALUE };
    return true;
  }
  if (!isPlainObject(next.env)) {
    if (!silent) {
      process.stderr.write(
        'mysecond: .claude/settings.json "env" is not an object — leaving it untouched.\n'
      );
    }
    return false;
  }
  const env = next.env;
  if (!(ENV_KEY in env)) {
    env[ENV_KEY] = ENV_VALUE;
    return true;
  }
  if (env[ENV_KEY] !== ENV_VALUE && !silent) {
    process.stderr.write(
      `mysecond: noted .claude/settings.json env.${ENV_KEY}=${String(env[ENV_KEY])} ` +
        `(customer value preserved over our default ${ENV_VALUE})\n`
    );
  }
  return false;
}

// Hook merge for ONE event (UserPromptSubmit or SubagentStop). Creates only
// MISSING containers; fails closed (skip, never overwrite) if a present container
// has the wrong type (Codex P1-5); finds our entry by the stable marker and
// rewrites in place on a version change, else appends our OWN group (customer
// hooks untouched). Returns true if it changed `next`.
function mergeEventHook(
  next: SettingsShape,
  eventName: string,
  desiredCommand: string,
  silent: boolean
): boolean {
  if (next.hooks === undefined) {
    next.hooks = {};
  } else if (!isPlainObject(next.hooks)) {
    if (!silent) {
      process.stderr.write(
        'mysecond: .claude/settings.json "hooks" is not an object — skipping usage-hook injection (left as-is).\n'
      );
    }
    return false;
  }
  const hooks = next.hooks as Record<string, unknown>;

  if (hooks[eventName] === undefined) {
    hooks[eventName] = [];
  } else if (!Array.isArray(hooks[eventName])) {
    if (!silent) {
      process.stderr.write(
        `mysecond: .claude/settings.json hooks.${eventName} is not an array — skipping usage-hook injection (left as-is).\n`
      );
    }
    return false;
  }
  const groups = hooks[eventName] as unknown[];

  // Find OUR hook by the stable marker (version-independent).
  for (const group of groups) {
    if (!isPlainObject(group)) continue;
    const inner = group.hooks;
    if (!Array.isArray(inner)) continue;
    for (const h of inner) {
      if (
        isPlainObject(h) &&
        typeof h.command === 'string' &&
        h.command.includes(HOOK_MARKER)
      ) {
        if (h.command === desiredCommand) return false; // already current → no-op
        // Version (or shape) drift → rewrite in place; preserve everything else.
        h.command = desiredCommand;
        h.type = 'command';
        h.timeout = HOOK_TIMEOUT;
        return true;
      }
    }
  }

  // Not present — append our OWN group so customer groups/hooks are never touched.
  groups.push({
    matcher: '',
    hooks: [{ type: 'command', command: desiredCommand, timeout: HOOK_TIMEOUT }],
  });
  return true;
}

// Ensure the mySecond env block + usage hook are present in the project's
// `.claude/settings.json`. BEST-EFFORT by contract: never throws into init /
// refresh / sync. Locked read-modify-write (the file is also written by env init;
// concurrent `mysecond` processes must not clobber each other — Codex P1-6). On a
// lock miss or unparseable file: writes NOTHING and returns (Codex P0-2).
export async function ensureCompanionHooks(
  rootDir: string,
  opts: { silent?: boolean; version?: string } = {}
): Promise<void> {
  const silent = opts.silent ?? false;
  const version = opts.version ?? __VERSION__;
  const settingsPath = projectPaths(rootDir).settingsPath;

  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    // proper-lockfile requires the target to exist before lock(). Materialize an
    // empty object if absent — valid JSON, clobbers nothing.
    if (!existsSync(settingsPath)) {
      atomicWriteFile(settingsPath, '{}\n');
    }

    let release: (() => Promise<void>) | null = null;
    try {
      release = await lockfile.lock(settingsPath, {
        retries: { retries: LOCK_RETRIES, minTimeout: LOCK_MIN_TIMEOUT_MS },
        stale: LOCK_STALE_MS,
      });
    } catch {
      // Couldn't acquire the lock — SKIP rather than an unlocked read-modify-write
      // that could clobber a concurrent locked writer. Re-done next run.
      return;
    }

    try {
      // Read FRESH under the lock. STRICT parse: on ANY parse error write NOTHING
      // (never clobber a present settings.json — Codex P0-2). An existing empty /
      // whitespace-only file is NOT valid JSON, so it is left byte-for-byte
      // untouched too. The legitimate "no settings yet" case is the ABSENT file,
      // already materialized to `{}` above — so a fresh install still gets the hook.
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
      } catch {
        if (!silent) {
          process.stderr.write(
            'mysecond: .claude/settings.json is not valid JSON — leaving it untouched (usage tracking not installed).\n'
          );
        }
        return;
      }

      const plan = planCompanionSettings(parsed, version, silent);
      if (plan.action === 'write') {
        atomicWriteFile(settingsPath, JSON.stringify(plan.next, null, 2) + '\n');
      }
      // noop / skip → write nothing.
    } finally {
      try {
        await release();
      } catch {
        // best-effort lock release
      }
    }
  } catch {
    // Best-effort by contract — never throw into init / refresh / sync.
  }
}
