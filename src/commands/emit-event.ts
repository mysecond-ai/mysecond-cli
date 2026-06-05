// `mysecond emit-event --silent` — usage-tracking hook dispatcher. The TS
// sibling of the bash hooks it replaces:
//   - emit-event.sh        (PostToolUse)         — autonomous Skill/Task tool
//                                                  calls + session_start
//   - emit-event-slash.sh  (UserPromptSubmit)     — user-typed slash commands
//
// Tool event arrives as JSON on stdin. ALWAYS exits 0 — this is best-effort
// hook plumbing and the customer's tool call shouldn't get blamed for our
// problems. Mirrors artifact-sync's guards (no credential → silent skip) and
// its best-effort posture (v1: no retry queue).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { emitHookEvent, type HookEventPayload } from '../lib/api.js';
import type { CommandContext } from '../lib/context.js';
import { mysecondHome } from '../lib/mysecond-paths.js';

const HOOK_VERSION = 'v1' as const;
const MAX_STDIN_BYTES = 1_000_000;

// Stdin event shape (Claude Code hook payload). All fields optional — a
// best-effort dispatcher must tolerate any subset.
interface HookEvent {
  hook_event_name?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_call_id?: string;
  session_id?: string;
  cwd?: string;
  tool_input?: {
    skill?: string;
    skill_name?: string;
    subagent_type?: string;
  };
  tool_response?: { is_error?: boolean } | unknown;
  // UserPromptExpansion: structured slash-command name + raw prompt fallback.
  command_name?: string;
  prompt?: string;
}

// Known workflow slugs. Their names do NOT contain the word "workflow"
// (competitive-intel-pack, problem-to-prd, …) — a bare *workflow* substring
// check misses every one — so match them explicitly. Keep in sync with the
// bash hooks (emit-event.sh / emit-event-slash.sh) and PMKit content/workflows/.
const WORKFLOWS: ReadonlySet<string> = new Set([
  'batch-interview-analysis',
  'competitive-intel-pack',
  'hypothesis-tester',
  'market-sizing-analyzer',
  'multi-review',
  'problem-to-prd',
  'voice-of-customer-analysis',
]);

// Subagent-spawn tool names. TaskCreate is the current Claude Code tool;
// Task/Agent are older names. Match all three so subagent_run is not dropped.
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['Task', 'Agent', 'TaskCreate']);

// Claude Code's self-management slash commands. These manage Claude Code
// itself, not "PM work" worth surfacing on the adoption dashboard — skip them.
// Conservative by design: a false negative is one harmless extra leaderboard
// row; a false positive silently drops a real skill. Keep in sync with
// emit-event-slash.sh.
const SLASH_DENYLIST: ReadonlySet<string> = new Set([
  'help', 'clear', 'cost', 'exit', 'quit', 'undo', 'login', 'logout',
  'permissions', 'config', 'model', 'release-notes', 'bug', 'doctor',
  'memory', 'compact', 'status', 'verbose', 'mcp', 'reset', 'history',
  'terminal-setup', 'approved-tools',
]);

async function readStdin(): Promise<string> {
  let buf = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    buf += chunk;
    if (buf.length > MAX_STDIN_BYTES) break;
  }
  return buf;
}

function parseEvent(raw: string): HookEvent | null {
  if (raw.trim().length === 0) return null;
  try {
    return JSON.parse(raw) as HookEvent;
  } catch {
    return null;
  }
}

// Drop the plugin namespace so the same skill/agent records under one
// canonical name regardless of which plugin shipped it
// (pm-os:prd-generator, customer-x:prd-generator → prd-generator).
function stripNamespace(name: string): string {
  const idx = name.lastIndexOf(':');
  return idx === -1 ? name : name.slice(idx + 1);
}

// Strip a leading `workflow-` prefix from a name (plugin-exported workflows
// carry it; content/workflows/ slugs do not).
function stripWorkflowPrefix(name: string): string {
  return name.startsWith('workflow-') ? name.slice('workflow-'.length) : name;
}

// Classify a skill/slash name into workflow_run vs skill_run + its emitted
// name (workflow names get the `workflow-` prefix stripped).
function classifySkill(name: string): { eventType: 'workflow_run' | 'skill_run'; name: string } {
  const isWorkflow = WORKFLOWS.has(name) || name.includes('workflow');
  return {
    eventType: isWorkflow ? 'workflow_run' : 'skill_run',
    name: stripWorkflowPrefix(name),
  };
}

// Scope guard: only emit inside a synced mySecond PM-OS project — a project
// marked by a .claude/sync-state.json that carries a "customerId" (written by
// init/sync to bind the project to an account). A bare sync-state.json with no
// customerId (e.g. a stale stub in an unrelated repo) does NOT count. Walk up
// from `startDir`; no marker → unrelated Claude Code session → skip. Mirrors
// the bash hooks' _in_pmos_project. Cheap string check (not JSON.parse) to
// match the bash `grep -q '"customerId"'` and tolerate a half-written file.
function inSyncedProject(startDir: string): boolean {
  let dir = startDir;
  while (dir.length > 0) {
    const f = join(dir, '.claude', 'sync-state.json');
    try {
      if (existsSync(f) && readFileSync(f, 'utf8').includes('"customerId"')) {
        return true;
      }
    } catch {
      // Unreadable — keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return false;
}

// session_start is emitted once per session, on the FIRST emit-event fire of a
// session, via a marker file under ~/.mysecond/sessions/<session_id> (shared
// with the bash hooks so only the first to fire — regardless of which branch —
// emits it). Returns true if this call won the race (marker did not exist).
function claimSessionStart(sessionId: string): boolean {
  const dir = join(mysecondHome(), 'sessions');
  const marker = join(dir, sessionId);
  try {
    if (existsSync(marker)) return false;
    mkdirSync(dir, { recursive: true });
    // Touch the marker. Best-effort: if two fires race, both may pass the
    // existsSync check and emit session_start — the server dedups on
    // (user_id, session_id, tool_call_id) where session_start's tool_call_id
    // is null, so NULLS NOT DISTINCT collapses the duplicate.
    writeFileSync(marker, '');
    return true;
  } catch {
    // Couldn't read/create the marker — skip the session_start emit rather
    // than risk a duplicate every fire.
    return false;
  }
}

// Build the type-specific event from a parsed hook payload. Returns null when
// the payload carries no trackable type-specific event (session_start is
// handled separately by the caller). Exported for unit tests.
export function buildTypeEvent(
  event: HookEvent,
  cwd: string,
  sessionId: string | null
): HookEventPayload | null {
  const hookName = event.hook_event_name;

  if (hookName === 'UserPromptSubmit' || hookName === 'UserPromptExpansion') {
    // Typed slash command. UserPromptSubmit (the event the plugin registers —
    // universal across Claude Code versions) carries the raw `prompt`;
    // UserPromptExpansion (accepted for forward-compat) carries a structured
    // `command_name`. Prefer command_name; fall back to a regex on the prompt.
    let name = '';
    if (typeof event.command_name === 'string' && event.command_name.length > 0) {
      name = event.command_name;
    } else if (typeof event.prompt === 'string') {
      const m = event.prompt.match(/^\/(?:[A-Za-z0-9_-]+:)?([A-Za-z][A-Za-z0-9_-]*)/);
      if (m && m[1] !== undefined) name = m[1];
    }
    name = stripNamespace(name.toLowerCase());
    if (name.length === 0) return null;
    if (SLASH_DENYLIST.has(name)) return null;

    const classified = classifySkill(name);
    return {
      event_type: classified.eventType,
      name: classified.name,
      session_id: sessionId,
      // Synthetic unique id — UserPromptExpansion has no real tool call. Must
      // be non-null + globally unique to respect the server's
      // (user_id, session_id, tool_call_id) dedup.
      tool_call_id: `prompt-${randomUUID()}`,
      cwd,
      error: false,
      hook_version: HOOK_VERSION,
    };
  }

  if (hookName === 'PostToolUse') {
    const toolName = event.tool_name;
    if (toolName === undefined) return null;

    const error =
      typeof event.tool_response === 'object' &&
      event.tool_response !== null &&
      (event.tool_response as { is_error?: boolean }).is_error === true;
    // Synthesize a unique id when the payload carries none, so an ID-less event
    // doesn't collide with session_start (also tool_call_id: null) or with other
    // ID-less events under the server's (user_id, session_id, tool_call_id)
    // NULLS-NOT-DISTINCT dedup — which would silently drop the real run (Codex P2).
    // A real tool_use_id is preferred (keeps proper dedup on retries).
    const toolCallId = event.tool_use_id ?? event.tool_call_id ?? `tool-${randomUUID()}`;

    if (toolName === 'Skill') {
      const rawName = event.tool_input?.skill ?? event.tool_input?.skill_name ?? '';
      const name = stripNamespace(rawName);
      if (name.length === 0) return null;
      const classified = classifySkill(name);
      return {
        event_type: classified.eventType,
        name: classified.name,
        session_id: sessionId,
        tool_call_id: toolCallId,
        cwd,
        error,
        hook_version: HOOK_VERSION,
      };
    }

    if (SUBAGENT_TOOLS.has(toolName)) {
      const name = stripNamespace(event.tool_input?.subagent_type ?? '');
      if (name.length === 0) return null;
      return {
        event_type: 'subagent_run',
        name,
        session_id: sessionId,
        tool_call_id: toolCallId,
        cwd,
        error,
        hook_version: HOOK_VERSION,
      };
    }

    // Other PostToolUse tools carry no type-specific event (session_start is
    // still handled by the caller).
    return null;
  }

  return null;
}

export async function runEmitEvent(
  _args: readonly string[],
  ctx: CommandContext
): Promise<number> {
  // No credential → silent skip (mirror artifact-sync's first guard).
  if (ctx.apiKey.length === 0) return 0;

  const raw = await readStdin();
  const event = parseEvent(raw);
  if (event === null) return 0;

  // cwd from the payload when present, else the resolved project root.
  const cwd = typeof event.cwd === 'string' && event.cwd.length > 0 ? event.cwd : ctx.rootDir;

  // Scope guard: only inside a synced mySecond project. Walk up from the
  // event's cwd (where the tool actually ran), falling back to rootDir.
  if (!inSyncedProject(cwd)) return 0;

  const sessionId =
    typeof event.session_id === 'string' && event.session_id.length > 0
      ? event.session_id
      : null;

  // session_start: once per session, on the FIRST fire regardless of branch.
  // Emitted even when the type-specific branch produces nothing.
  if (sessionId !== null && claimSessionStart(sessionId)) {
    await emitHookEvent(ctx, {
      event_type: 'session_start',
      name: null,
      session_id: sessionId,
      tool_call_id: null,
      cwd,
      error: false,
      hook_version: HOOK_VERSION,
    });
  }

  // Type-specific event (skill_run / workflow_run / subagent_run).
  const typeEvent = buildTypeEvent(event, cwd, sessionId);
  if (typeEvent !== null) {
    await emitHookEvent(ctx, typeEvent);
  }

  return 0;
}
