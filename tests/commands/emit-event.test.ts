// Tests for runEmitEvent — the usage-tracking hook dispatcher. Mocks the fetch
// transport and stubs process.stdin so each test exercises the real path:
// parse stdin → scope guard → classify → POST /api/hooks/events. Mirrors the
// artifact-sync.test.ts template (fetch mock + stdin stub + tmp project).
//
// HOME is redirected to a per-test tmpdir so the ~/.mysecond/sessions/<id>
// session_start marker writes never touch the real home or leak across tests
// (pool: 'forks' isolates process.env per file — see vitest.config.ts).

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runEmitEvent } from '../../src/commands/emit-event.js';
import type { CommandContext } from '../../src/lib/context.js';

// A synced PM-OS project: .claude/sync-state.json carrying a "customerId".
function tmpProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'mysecond-emit-event-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(
    join(root, '.claude/sync-state.json'),
    JSON.stringify({ customerId: 'cust_test_123' }, null, 2)
  );
  return root;
}

// A project tree with NO customerId marker (unrelated Claude Code session).
function tmpNonProject(): string {
  return mkdtempSync(join(tmpdir(), 'mysecond-emit-event-bare-'));
}

function ctx(rootDir: string, overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    apiBase: 'https://app.mysecond.ai',
    apiKey: 'test-key',
    rootDir,
    silent: true,
    dryRun: false,
    forceUpdate: false,
    fix: false,
    strategy: 'cloud-wins',
    ...overrides,
  };
}

function emptyResponse(status = 204): Response {
  return new Response(status === 204 ? null : '', { status });
}

function stubStdin(payload: string): void {
  const stream = Readable.from([payload]);
  (stream as unknown as { setEncoding: (e: string) => void }).setEncoding = () => {};
  Object.defineProperty(process, 'stdin', { value: stream, configurable: true });
}

let uniqueCounter = 0;
function uniqueSession(): string {
  uniqueCounter += 1;
  return `sess_${Date.now()}_${uniqueCounter}`;
}

// Find the fetch call whose body has the given event_type. session_start may
// be POSTed alongside the type event, so tests select the call they care about.
function callForEventType(
  fetchMock: ReturnType<typeof vi.fn>,
  eventType: string
): { url: URL; body: Record<string, unknown> } | null {
  for (const call of fetchMock.mock.calls) {
    const [url, init] = call as [URL, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    if (body.event_type === eventType) return { url, body };
  }
  return null;
}

describe('runEmitEvent', () => {
  let originalFetch: typeof fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalStdin: NodeJS.ReadStream;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn().mockResolvedValue(emptyResponse(204));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    originalStdin = process.stdin;
    // Redirect ~/.mysecond/sessions to an isolated tmp home per test.
    originalHome = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), 'mysecond-emit-home-'));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  // ---- guards -------------------------------------------------------------

  it('exits 0 immediately when apiKey is empty (no fetch)', async () => {
    const root = tmpProject();
    stubStdin(
      JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Skill',
        tool_input: { skill: 'prd-generator' },
        session_id: uniqueSession(),
        cwd: root,
      })
    );

    const code = await runEmitEvent([], ctx(root, { apiKey: '' }));
    expect(code).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exits 0 with no fetch when not inside a synced PM-OS project', async () => {
    const root = tmpNonProject(); // no .claude/sync-state.json customerId
    stubStdin(
      JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Skill',
        tool_input: { skill: 'prd-generator' },
        session_id: uniqueSession(),
        cwd: root,
      })
    );

    const code = await runEmitEvent([], ctx(root));
    expect(code).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exits 0 on empty/garbage stdin (no fetch)', async () => {
    const root = tmpProject();
    stubStdin('not json at all');

    const code = await runEmitEvent([], ctx(root));
    expect(code).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ---- PostToolUse: Skill -> skill_run -----------------------------------

  it('classifies a Skill tool call as skill_run with the correct POST body shape', async () => {
    const root = tmpProject();
    const sessionId = uniqueSession();
    stubStdin(
      JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Skill',
        tool_input: { skill: 'prd-generator' },
        tool_use_id: 'toolu_abc',
        session_id: sessionId,
        cwd: root,
        tool_response: { is_error: false },
      })
    );

    const code = await runEmitEvent([], ctx(root));
    expect(code).toBe(0);

    const hit = callForEventType(fetchMock, 'skill_run');
    expect(hit).not.toBeNull();
    expect(hit!.url.toString()).toBe('https://app.mysecond.ai/api/hooks/events');
    // Bearer auth header.
    const init = fetchMock.mock.calls.find(
      (c) => JSON.parse((c[1] as RequestInit).body as string).event_type === 'skill_run'
    )![1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-key');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.method).toBe('POST');

    expect(hit!.body).toEqual({
      event_type: 'skill_run',
      name: 'prd-generator',
      session_id: sessionId,
      tool_call_id: 'toolu_abc',
      cwd: root,
      error: false,
      hook_version: 'v1',
    });
  });

  it('reads skill_name when skill is absent, and reports error from tool_response.is_error', async () => {
    const root = tmpProject();
    stubStdin(
      JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Skill',
        tool_input: { skill_name: 'roadmap-builder' },
        tool_use_id: 'toolu_err',
        session_id: uniqueSession(),
        cwd: root,
        tool_response: { is_error: true },
      })
    );

    await runEmitEvent([], ctx(root));
    const hit = callForEventType(fetchMock, 'skill_run');
    expect(hit!.body.name).toBe('roadmap-builder');
    expect(hit!.body.error).toBe(true);
  });

  // ---- namespace stripping ------------------------------------------------

  it('strips the plugin namespace from a Skill name (pm-os:prd-generator -> prd-generator)', async () => {
    const root = tmpProject();
    stubStdin(
      JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Skill',
        tool_input: { skill: 'pm-os:prd-generator' },
        tool_use_id: 'toolu_ns',
        session_id: uniqueSession(),
        cwd: root,
      })
    );

    await runEmitEvent([], ctx(root));
    const hit = callForEventType(fetchMock, 'skill_run');
    expect(hit!.body.name).toBe('prd-generator');
  });

  // ---- workflow classification -------------------------------------------

  it('classifies a known workflow slug as workflow_run', async () => {
    const root = tmpProject();
    stubStdin(
      JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Skill',
        tool_input: { skill: 'competitive-intel-pack' },
        tool_use_id: 'toolu_wf',
        session_id: uniqueSession(),
        cwd: root,
      })
    );

    await runEmitEvent([], ctx(root));
    const hit = callForEventType(fetchMock, 'workflow_run');
    expect(hit).not.toBeNull();
    expect(hit!.body.name).toBe('competitive-intel-pack');
    expect(callForEventType(fetchMock, 'skill_run')).toBeNull();
  });

  it('classifies a *workflow* substring name as workflow_run and strips the workflow- prefix', async () => {
    const root = tmpProject();
    stubStdin(
      JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Skill',
        tool_input: { skill: 'pm-specs:workflow-problem-to-prd' },
        tool_use_id: 'toolu_wfp',
        session_id: uniqueSession(),
        cwd: root,
      })
    );

    await runEmitEvent([], ctx(root));
    const hit = callForEventType(fetchMock, 'workflow_run');
    expect(hit).not.toBeNull();
    // namespace stripped -> 'workflow-problem-to-prd' -> matches *workflow* ->
    // workflow- prefix stripped -> 'problem-to-prd'.
    expect(hit!.body.name).toBe('problem-to-prd');
  });

  // ---- subagent_run (Task / Agent / TaskCreate) --------------------------

  it.each(['Task', 'Agent', 'TaskCreate'])(
    'classifies %s tool as subagent_run with the subagent_type as name',
    async (toolName) => {
      const root = tmpProject();
      stubStdin(
        JSON.stringify({
          hook_event_name: 'PostToolUse',
          tool_name: toolName,
          tool_input: { subagent_type: 'pm-os:cto-tech-lead' },
          tool_use_id: `toolu_${toolName}`,
          session_id: uniqueSession(),
          cwd: root,
        })
      );

      await runEmitEvent([], ctx(root));
      const hit = callForEventType(fetchMock, 'subagent_run');
      expect(hit).not.toBeNull();
      // namespace stripped.
      expect(hit!.body.name).toBe('cto-tech-lead');
      expect(hit!.body.tool_call_id).toBe(`toolu_${toolName}`);
    }
  );

  // ---- subagent_run via SubagentStop (the real settings.json-delivered path) ---

  it('classifies a SubagentStop event as subagent_run, reading the TOP-LEVEL agent_type', async () => {
    const root = tmpProject();
    const sessionId = uniqueSession();
    stubStdin(
      JSON.stringify({
        hook_event_name: 'SubagentStop',
        agent_type: 'pm-os:cto-tech-lead', // top-level — NOT tool_input.subagent_type
        session_id: sessionId,
        cwd: root,
      })
    );

    await runEmitEvent([], ctx(root));
    const hit = callForEventType(fetchMock, 'subagent_run');
    expect(hit).not.toBeNull();
    expect(hit!.body.name).toBe('cto-tech-lead'); // namespace stripped
    expect(hit!.body.session_id).toBe(sessionId);
    // synthetic unique id so the server's (user,session,tool_call_id) dedup keeps
    // each distinct subagent run as its own row.
    expect(String(hit!.body.tool_call_id)).toMatch(/^subagent-/);
    expect(hit!.body.error).toBe(false);
  });

  it('uses the payload agent_id for the dedup tool_call_id when present', async () => {
    const root = tmpProject();
    stubStdin(
      JSON.stringify({
        hook_event_name: 'SubagentStop',
        agent_type: 'cto',
        agent_id: 'agent-abc-123',
        session_id: uniqueSession(),
        cwd: root,
      })
    );
    await runEmitEvent([], ctx(root));
    const hit = callForEventType(fetchMock, 'subagent_run');
    // stable dedup key (not a random UUID) → a replayed SubagentStop collapses.
    expect(hit!.body.tool_call_id).toBe('subagent-agent-abc-123');
  });

  it('falls back to tool_input.subagent_type on SubagentStop when agent_type is absent', async () => {
    const root = tmpProject();
    stubStdin(
      JSON.stringify({
        hook_event_name: 'SubagentStop',
        tool_input: { subagent_type: 'general-purpose' },
        session_id: uniqueSession(),
        cwd: root,
      })
    );
    await runEmitEvent([], ctx(root));
    const hit = callForEventType(fetchMock, 'subagent_run');
    expect(hit).not.toBeNull();
    expect(hit!.body.name).toBe('general-purpose');
  });

  it('emits no subagent_run for a SubagentStop with no resolvable agent type', async () => {
    const root = tmpProject();
    stubStdin(
      JSON.stringify({
        hook_event_name: 'SubagentStop',
        session_id: uniqueSession(),
        cwd: root,
      })
    );
    await runEmitEvent([], ctx(root));
    expect(callForEventType(fetchMock, 'subagent_run')).toBeNull();
    // session_start still fires (first fire of the session).
    expect(callForEventType(fetchMock, 'session_start')).not.toBeNull();
  });

  it('does NOT emit a type event for a non-tracked PostToolUse tool (e.g. Bash)', async () => {
    const root = tmpProject();
    stubStdin(
      JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: {},
        session_id: uniqueSession(),
        cwd: root,
      })
    );

    await runEmitEvent([], ctx(root));
    expect(callForEventType(fetchMock, 'skill_run')).toBeNull();
    expect(callForEventType(fetchMock, 'workflow_run')).toBeNull();
    expect(callForEventType(fetchMock, 'subagent_run')).toBeNull();
    // session_start still fires (first fire of the session).
    expect(callForEventType(fetchMock, 'session_start')).not.toBeNull();
  });

  it('synthesizes a tool_call_id for an ID-less PostToolUse event (avoids session_start collision)', async () => {
    const root = tmpProject();
    stubStdin(
      JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Skill',
        tool_input: { skill: 'prd-generator' },
        session_id: uniqueSession(),
        cwd: root,
        // NB: no tool_use_id / tool_call_id in the payload.
      })
    );

    await runEmitEvent([], ctx(root));
    const hit = callForEventType(fetchMock, 'skill_run');
    expect(hit).not.toBeNull();
    // Synthetic id, not null — so it can't dedup-collide with session_start.
    expect(hit!.body.tool_call_id).toMatch(/^tool-[0-9a-f-]{36}$/);
  });

  // ---- UserPromptSubmit / UserPromptExpansion (typed slash commands) -------

  it('classifies a typed slash command via UserPromptSubmit (raw prompt) as skill_run', async () => {
    // UserPromptSubmit is the event the plugin actually registers (universal
    // across Claude Code versions). It carries the raw prompt, not command_name.
    const root = tmpProject();
    const sessionId = uniqueSession();
    stubStdin(
      JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        prompt: '/prd-generator draft the spec',
        session_id: sessionId,
        cwd: root,
      })
    );

    await runEmitEvent([], ctx(root));
    const hit = callForEventType(fetchMock, 'skill_run');
    expect(hit).not.toBeNull();
    expect(hit!.body.name).toBe('prd-generator');
    expect(hit!.body.tool_call_id).toMatch(/^prompt-[0-9a-f-]{36}$/);
    expect(hit!.body.session_id).toBe(sessionId);
  });

  it('classifies a typed slash command (command_name) as skill_run with a synthetic prompt- id', async () => {
    const root = tmpProject();
    const sessionId = uniqueSession();
    stubStdin(
      JSON.stringify({
        hook_event_name: 'UserPromptExpansion',
        command_name: 'PRD-Generator',
        session_id: sessionId,
        cwd: root,
      })
    );

    await runEmitEvent([], ctx(root));
    const hit = callForEventType(fetchMock, 'skill_run');
    expect(hit).not.toBeNull();
    expect(hit!.body.name).toBe('prd-generator'); // lowercased
    expect(hit!.body.tool_call_id).toMatch(/^prompt-[0-9a-f-]{36}$/);
    expect(hit!.body.error).toBe(false);
    expect(hit!.body.session_id).toBe(sessionId);
  });

  it('falls back to the prompt regex when command_name is absent, stripping the namespace', async () => {
    const root = tmpProject();
    stubStdin(
      JSON.stringify({
        hook_event_name: 'UserPromptExpansion',
        prompt: '/pm-os:roadmap-builder build me a roadmap',
        session_id: uniqueSession(),
        cwd: root,
      })
    );

    await runEmitEvent([], ctx(root));
    const hit = callForEventType(fetchMock, 'skill_run');
    expect(hit).not.toBeNull();
    expect(hit!.body.name).toBe('roadmap-builder');
  });

  it('skips denylisted built-in slash commands (e.g. /help) — no type event', async () => {
    const root = tmpProject();
    stubStdin(
      JSON.stringify({
        hook_event_name: 'UserPromptExpansion',
        command_name: 'help',
        session_id: uniqueSession(),
        cwd: root,
      })
    );

    await runEmitEvent([], ctx(root));
    expect(callForEventType(fetchMock, 'skill_run')).toBeNull();
    expect(callForEventType(fetchMock, 'workflow_run')).toBeNull();
  });

  it('classifies a typed slash workflow command as workflow_run', async () => {
    const root = tmpProject();
    stubStdin(
      JSON.stringify({
        hook_event_name: 'UserPromptExpansion',
        command_name: 'multi-review',
        session_id: uniqueSession(),
        cwd: root,
      })
    );

    await runEmitEvent([], ctx(root));
    const hit = callForEventType(fetchMock, 'workflow_run');
    expect(hit).not.toBeNull();
    expect(hit!.body.name).toBe('multi-review');
  });

  // ---- session_start once-per-session ------------------------------------

  it('emits session_start exactly once per session (second fire does not re-emit)', async () => {
    const root = tmpProject();
    const sessionId = uniqueSession();

    // First fire — should emit session_start + skill_run.
    stubStdin(
      JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Skill',
        tool_input: { skill: 'prd-generator' },
        tool_use_id: 'toolu_1',
        session_id: sessionId,
        cwd: root,
      })
    );
    await runEmitEvent([], ctx(root));

    const firstStart = fetchMock.mock.calls.filter(
      (c) => JSON.parse((c[1] as RequestInit).body as string).event_type === 'session_start'
    );
    expect(firstStart).toHaveLength(1);
    // session_start carries null name + null tool_call_id.
    expect(JSON.parse((firstStart[0]![1] as RequestInit).body as string)).toEqual({
      event_type: 'session_start',
      name: null,
      session_id: sessionId,
      tool_call_id: null,
      cwd: root,
      error: false,
      hook_version: 'v1',
    });

    // Second fire, SAME session — must NOT emit session_start again.
    fetchMock.mockClear();
    stubStdin(
      JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Skill',
        tool_input: { skill: 'roadmap-builder' },
        tool_use_id: 'toolu_2',
        session_id: sessionId,
        cwd: root,
      })
    );
    await runEmitEvent([], ctx(root));

    expect(callForEventType(fetchMock, 'session_start')).toBeNull();
    expect(callForEventType(fetchMock, 'skill_run')).not.toBeNull();
  });

  it('does not emit session_start when session_id is missing', async () => {
    const root = tmpProject();
    stubStdin(
      JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Skill',
        tool_input: { skill: 'prd-generator' },
        tool_use_id: 'toolu_nosess',
        cwd: root,
        // no session_id
      })
    );

    await runEmitEvent([], ctx(root));
    expect(callForEventType(fetchMock, 'session_start')).toBeNull();
    // Type event still fires, with null session_id.
    const hit = callForEventType(fetchMock, 'skill_run');
    expect(hit!.body.session_id).toBeNull();
  });

  // ---- best-effort: never throws on transport failure --------------------

  it('returns 0 even when the POST fails (5xx) — best-effort, no throw', async () => {
    const root = tmpProject();
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
    stubStdin(
      JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Skill',
        tool_input: { skill: 'prd-generator' },
        tool_use_id: 'toolu_5xx',
        session_id: uniqueSession(),
        cwd: root,
      })
    );

    const code = await runEmitEvent([], ctx(root));
    expect(code).toBe(0);
  });

  it('returns 0 even when the network throws — best-effort, no throw', async () => {
    const root = tmpProject();
    fetchMock.mockRejectedValue(new Error('offline'));
    stubStdin(
      JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Skill',
        tool_input: { skill: 'prd-generator' },
        tool_use_id: 'toolu_off',
        session_id: uniqueSession(),
        cwd: root,
      })
    );

    const code = await runEmitEvent([], ctx(root));
    expect(code).toBe(0);
  });
});
