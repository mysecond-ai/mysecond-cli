// Tests for companion-hooks — the locked, strict-parse, fail-closed, stable-marker
// merge that injects the usage-tracking UserPromptSubmit hook (+ the env block)
// into a project's `.claude/settings.json`. Covers every Codex round-3 finding:
//  P0-1 the buffered-replay command shape; P0-2 strict-parse / never-clobber;
//  P0-3 stable marker → version bump replaces in place (no duplicate);
//  P1-5 fail-closed on schema-invalid containers; P1-6 concurrent writes serialize.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import lockfile from 'proper-lockfile';
import { describe, expect, it } from 'vitest';

import {
  buildHookCommand,
  ensureCompanionHooks,
  HOOK_MARKER,
  planCompanionSettings,
  type PlanResult,
} from '../../src/lib/companion-hooks.js';

const ENV_KEY = 'SLASH_COMMAND_TOOL_CHAR_BUDGET';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'mysecond-companion-'));
}

function settingsPathOf(root: string): string {
  return join(root, '.claude', 'settings.json');
}

function readSettings(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPathOf(root), 'utf8')) as Record<string, unknown>;
}

// Count hooks (across all groups for the given event) whose command carries our marker.
function countMarkedHooks(settings: Record<string, unknown>, eventName = 'UserPromptSubmit'): string[] {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  const groups = hooks?.[eventName];
  if (!Array.isArray(groups)) return [];
  const out: string[] = [];
  for (const g of groups) {
    const inner = (g as { hooks?: unknown }).hooks;
    if (!Array.isArray(inner)) continue;
    for (const h of inner) {
      const cmd = (h as { command?: unknown }).command;
      if (typeof cmd === 'string' && cmd.includes(HOOK_MARKER)) out.push(cmd);
    }
  }
  return out;
}

function expectWrite(r: PlanResult): Record<string, unknown> {
  expect(r.action).toBe('write');
  return (r as { action: 'write'; next: Record<string, unknown> }).next;
}

describe('buildHookCommand', () => {
  it('buffers stdin, version-gates the global, pins npx, and carries the stable marker', () => {
    const cmd = buildHookCommand('1.8.0');
    expect(cmd).toContain('json=$(cat)'); // P0-1: buffer stdin once
    expect(cmd).toContain('command -v mysecond'); // global fast-path requires a global...
    expect(cmd).toContain('[ "$(mysecond --version </dev/null 2>/dev/null)" = "1.8.0" ]'); // ...of the EXACT pinned version (P1)
    expect(cmd).toContain('printf "%s" "$json" | mysecond emit-event'); // global arm
    expect(cmd).toContain('&& exit 0'); // global arm only on success
    expect(cmd).toContain('printf "%s" "$json" | npx -y @mysecond/cli@1.8.0 emit-event'); // pinned npx replay
    expect(cmd).toContain('|| true'); // non-fatal
    expect(cmd).toContain(`# ${HOOK_MARKER}`); // P0-3: stable marker
  });

  it('the marker is independent of the version', () => {
    expect(buildHookCommand('1.8.0')).toContain(HOOK_MARKER);
    expect(buildHookCommand('2.0.0')).toContain(HOOK_MARKER);
  });
});

describe('planCompanionSettings — fresh + idempotency', () => {
  it('on an empty object: writes the env block and one UserPromptSubmit hook', () => {
    const next = expectWrite(planCompanionSettings({}, '1.8.0', true));
    expect((next.env as Record<string, string>)[ENV_KEY]).toBe('20000');
    const marked = countMarkedHooks(next);
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain('@mysecond/cli@1.8.0');
  });

  it('is idempotent: re-planning the result is a noop', () => {
    const next = expectWrite(planCompanionSettings({}, '1.8.0', true));
    const again = planCompanionSettings(next, '1.8.0', true);
    expect(again.action).toBe('noop');
  });
});

describe('planCompanionSettings — version rewrite (P0-3)', () => {
  it('a version bump replaces our command in place — never appends a second hook', () => {
    const v1 = expectWrite(planCompanionSettings({}, '1.8.0', true));
    expect(countMarkedHooks(v1)).toHaveLength(1);

    const v2 = expectWrite(planCompanionSettings(v1, '1.9.0', true));
    const marked = countMarkedHooks(v2);
    expect(marked).toHaveLength(1); // still ONE, not two
    expect(marked[0]).toContain('@mysecond/cli@1.9.0'); // updated
    expect(marked[0]).not.toContain('@mysecond/cli@1.8.0');
  });
});

describe('planCompanionSettings — SubagentStop hook (sub-agent tracking)', () => {
  it('injects BOTH a UserPromptSubmit and a SubagentStop hook with the same command', () => {
    const next = expectWrite(planCompanionSettings({}, '1.9.0', true));
    const ups = countMarkedHooks(next, 'UserPromptSubmit');
    const sas = countMarkedHooks(next, 'SubagentStop');
    expect(ups).toHaveLength(1);
    expect(sas).toHaveLength(1);
    expect(sas[0]).toBe(ups[0]); // one command string, two events
  });

  it('is idempotent across both events (re-plan = noop)', () => {
    const next = expectWrite(planCompanionSettings({}, '1.9.0', true));
    expect(planCompanionSettings(next, '1.9.0', true).action).toBe('noop');
  });

  it('a version bump rewrites BOTH hooks in place (one each, new version)', () => {
    const v1 = expectWrite(planCompanionSettings({}, '1.9.0', true));
    const v2 = expectWrite(planCompanionSettings(v1, '2.0.0', true));
    for (const ev of ['UserPromptSubmit', 'SubagentStop']) {
      const marked = countMarkedHooks(v2, ev);
      expect(marked).toHaveLength(1);
      expect(marked[0]).toContain('@mysecond/cli@2.0.0');
      expect(marked[0]).not.toContain('@mysecond/cli@1.9.0');
    }
  });

  it('preserves a customer SubagentStop hook and appends ours', () => {
    const customer = {
      hooks: { SubagentStop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo custom-subagent' }] }] },
    };
    const next = expectWrite(planCompanionSettings(customer, '1.9.0', true));
    expect(JSON.stringify(next.hooks)).toContain('echo custom-subagent');
    expect(countMarkedHooks(next, 'SubagentStop')).toHaveLength(1);
  });
});

describe('planCompanionSettings — customer config is preserved', () => {
  it('appends our group while keeping a customer UserPromptSubmit hook', () => {
    const customer = {
      hooks: {
        UserPromptSubmit: [
          { matcher: '', hooks: [{ type: 'command', command: 'echo customer-hook' }] },
        ],
      },
    };
    const next = expectWrite(planCompanionSettings(customer, '1.8.0', true));
    const allCommands = JSON.stringify(next.hooks);
    expect(allCommands).toContain('echo customer-hook'); // customer preserved
    expect(countMarkedHooks(next)).toHaveLength(1); // ours added
  });

  it('preserves a customer-authored env value (customer wins) and still adds the hook', () => {
    const customer = { env: { [ENV_KEY]: '99999', OTHER: 'keep' } };
    const next = expectWrite(planCompanionSettings(customer, '1.8.0', true));
    const env = next.env as Record<string, string>;
    expect(env[ENV_KEY]).toBe('99999'); // customer value untouched
    expect(env.OTHER).toBe('keep');
    expect(countMarkedHooks(next)).toHaveLength(1);
  });

  it('preserves unrelated top-level keys (e.g. permissions)', () => {
    const customer = { permissions: { allow: ['Bash(ls)'] } };
    const next = expectWrite(planCompanionSettings(customer, '1.8.0', true));
    expect(next.permissions).toEqual({ allow: ['Bash(ls)'] });
  });
});

describe('planCompanionSettings — fail closed (P0-2 / P1-5)', () => {
  it('skips a non-object root and never produces a write', () => {
    expect(planCompanionSettings([], '1.8.0', true)).toEqual({ action: 'skip', reason: 'not-an-object' });
    expect(planCompanionSettings('nope', '1.8.0', true)).toEqual({ action: 'skip', reason: 'not-an-object' });
    expect(planCompanionSettings(null, '1.8.0', true)).toEqual({ action: 'skip', reason: 'not-an-object' });
  });

  it('leaves a non-object "hooks" container untouched and skips the hook (still writes env)', () => {
    const next = expectWrite(planCompanionSettings({ hooks: 'garbage' }, '1.8.0', true));
    expect(next.hooks).toBe('garbage'); // not clobbered
    expect((next.env as Record<string, string>)[ENV_KEY]).toBe('20000'); // env still ensured
    expect(countMarkedHooks(next)).toHaveLength(0); // no hook injected into garbage
  });

  it('leaves a non-array UserPromptSubmit untouched (SubagentStop still injected independently)', () => {
    // env already set; UserPromptSubmit is malformed → skipped (NOT coerced); but
    // SubagentStop is absent → it gets added, so the overall action is 'write'.
    // The two events are independent: one malformed container never blocks the other.
    const input = { env: { [ENV_KEY]: '20000' }, hooks: { UserPromptSubmit: 'bad' } };
    const next = expectWrite(planCompanionSettings(input, '1.8.0', true));
    // the bad UserPromptSubmit value is preserved verbatim, not turned into an array:
    expect((next.hooks as { UserPromptSubmit: unknown }).UserPromptSubmit).toBe('bad');
    expect(countMarkedHooks(next, 'UserPromptSubmit')).toHaveLength(0);
    expect(countMarkedHooks(next, 'SubagentStop')).toHaveLength(1);
  });
});

describe('ensureCompanionHooks — disk IO', () => {
  it('creates settings.json with env + both hooks in a fresh project', async () => {
    const root = tmpProject();
    await ensureCompanionHooks(root, { silent: true, version: '1.9.0' });
    const s = readSettings(root);
    expect((s.env as Record<string, string>)[ENV_KEY]).toBe('20000');
    expect(countMarkedHooks(s, 'UserPromptSubmit')).toHaveLength(1);
    expect(countMarkedHooks(s, 'SubagentStop')).toHaveLength(1);
  });

  it('is idempotent on disk: running twice leaves exactly one hook', async () => {
    const root = tmpProject();
    await ensureCompanionHooks(root, { silent: true, version: '1.8.0' });
    await ensureCompanionHooks(root, { silent: true, version: '1.8.0' });
    expect(countMarkedHooks(readSettings(root))).toHaveLength(1);
  });

  it('a version bump on disk rewrites in place (one hook, new version)', async () => {
    const root = tmpProject();
    await ensureCompanionHooks(root, { silent: true, version: '1.8.0' });
    await ensureCompanionHooks(root, { silent: true, version: '1.9.0' });
    const marked = countMarkedHooks(readSettings(root));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain('@mysecond/cli@1.9.0');
  });

  it('NEVER clobbers a corrupt-but-present settings.json (Codex P0-2)', async () => {
    const root = tmpProject();
    mkdirSync(join(root, '.claude'), { recursive: true });
    const corrupt = '{ this is not valid json ';
    writeFileSync(settingsPathOf(root), corrupt);
    await ensureCompanionHooks(root, { silent: true, version: '1.8.0' });
    expect(readFileSync(settingsPathOf(root), 'utf8')).toBe(corrupt); // untouched
  });

  it('preserves existing customer settings + adds the hook', async () => {
    const root = tmpProject();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(
      settingsPathOf(root),
      JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, env: { FOO: 'bar' } }, null, 2),
    );
    await ensureCompanionHooks(root, { silent: true, version: '1.8.0' });
    const s = readSettings(root);
    expect(s.permissions).toEqual({ allow: ['Bash(ls)'] });
    expect((s.env as Record<string, string>).FOO).toBe('bar');
    expect((s.env as Record<string, string>)[ENV_KEY]).toBe('20000');
    expect(countMarkedHooks(s)).toHaveLength(1);
  });

  it('concurrent calls serialize and do not double-add the hook (Codex P1-6)', async () => {
    const root = tmpProject();
    await Promise.all([
      ensureCompanionHooks(root, { silent: true, version: '1.8.0' }),
      ensureCompanionHooks(root, { silent: true, version: '1.8.0' }),
      ensureCompanionHooks(root, { silent: true, version: '1.8.0' }),
    ]);
    expect(countMarkedHooks(readSettings(root))).toHaveLength(1);
  });

  it('leaves an existing EMPTY settings.json byte-for-byte untouched (Codex P0-2)', async () => {
    const root = tmpProject();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(settingsPathOf(root), '');
    await ensureCompanionHooks(root, { silent: true, version: '1.8.0' });
    expect(readFileSync(settingsPathOf(root), 'utf8')).toBe('');
  });

  it('leaves an existing WHITESPACE-only settings.json byte-for-byte untouched (Codex P0-2)', async () => {
    const root = tmpProject();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(settingsPathOf(root), '   \n');
    await ensureCompanionHooks(root, { silent: true, version: '1.8.0' });
    expect(readFileSync(settingsPathOf(root), 'utf8')).toBe('   \n');
  });

  it('skips (writes nothing) when another process holds the settings.json lock (Codex P1-6)', async () => {
    const root = tmpProject();
    mkdirSync(join(root, '.claude'), { recursive: true });
    const p = settingsPathOf(root);
    writeFileSync(p, '{}\n');
    const release = await lockfile.lock(p, { stale: 30_000 });
    try {
      await ensureCompanionHooks(root, { silent: true, version: '1.8.0' });
      // Lock held elsewhere → helper retried, failed to acquire, skipped (never an
      // unlocked write) → file unchanged.
      expect(readFileSync(p, 'utf8')).toBe('{}\n');
    } finally {
      await release();
    }
  });
});

// Execution-level proof of the P0-1 stdin replay + the P1 version-gate: the unit
// tests above check the command STRING; these RUN it with stub `mysecond`/`npx` on
// PATH and prove which arm actually receives the buffered event JSON.
describe('the injected command (stdin replay + version-gate)', () => {
  // Strip the `bash -lc '…'` wrapper and run the inner command via `bash -c` with a
  // stub bin on PATH (`-c` not `-lc`: the login-shell PATH reset is irrelevant here).
  function runInner(version: string, eventJson: string, bin: string): void {
    const full = buildHookCommand(version);
    const inner = full.slice("bash -lc '".length, full.length - 1);
    execFileSync('bash', ['-c', inner], {
      input: eventJson,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
  }

  it('a STALE-version global is skipped and the npx arm gets the original stdin (P1)', () => {
    const bin = mkdtempSync(join(tmpdir(), 'mysecond-bin-'));
    const npxCapture = join(bin, 'npx.json');
    // Stale global: `--version` reports a non-pinned version (gate skips it); any
    // other call drains stdin + exits non-zero. Either way it must not handle the event.
    writeFileSync(
      join(bin, 'mysecond'),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "0.0.0-stale"; exit 0; fi\ncat >/dev/null\nexit 1\n'
    );
    chmodSync(join(bin, 'mysecond'), 0o755);
    writeFileSync(join(bin, 'npx'), `#!/bin/sh\ncat > "${npxCapture}"\n`);
    chmodSync(join(bin, 'npx'), 0o755);

    const eventJson = '{"hook_event_name":"UserPromptSubmit","prompt":"/prd-generator"}';
    runInner('1.8.0', eventJson, bin);
    // npx (pinned) got the ORIGINAL json; the stale global never handled it.
    expect(readFileSync(npxCapture, 'utf8')).toBe(eventJson);
  });

  it('a MATCHING-version global handles the event and npx never runs (fast path)', () => {
    const bin = mkdtempSync(join(tmpdir(), 'mysecond-bin-'));
    const globalCapture = join(bin, 'global.json');
    const npxCapture = join(bin, 'npx.json');
    // Matching global: `--version` == pinned; emit-event captures stdin + exits 0.
    writeFileSync(
      join(bin, 'mysecond'),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "1.8.0"; exit 0; fi\ncat > "${globalCapture}"\nexit 0\n`
    );
    chmodSync(join(bin, 'mysecond'), 0o755);
    writeFileSync(join(bin, 'npx'), `#!/bin/sh\ncat > "${npxCapture}"\n`);
    chmodSync(join(bin, 'npx'), 0o755);

    const eventJson = '{"hook_event_name":"SubagentStop","agent_type":"cto"}';
    runInner('1.8.0', eventJson, bin);
    expect(readFileSync(globalCapture, 'utf8')).toBe(eventJson); // global handled it
    expect(existsSync(npxCapture)).toBe(false); // npx never ran
  });
});
