// Runner-level regression lock for the desktop-install fix (plan Part 7).
//
// The single most important behavior this fix introduces: when step 9
// (plugin registration) returns a `degraded` outcome, the runner must NOT
// abort — it continues to the first-sync step so the customer's context still
// syncs, it does NOT ledger the degraded step (so a re-run re-attempts it), and
// the install still exits 0 while honestly flagging plugin_registered:false.
//
// We drive the REAL runInit with a stubbed STEPS list (a degradable step + a
// later sync step) against a real temp sync-state, so the ledger + control flow
// are exercised for real, not asserted by source-reading.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const ranSync = { value: false };
  const degradedStep = vi.fn(async (sctx: { shared: Record<string, unknown> }) => {
    // Mimic real step 9 on a registration failure.
    sctx.shared.pluginRegistered = false;
    sctx.shared.registrationDegradedReason = 'test: claude not found';
    return { step: 9, outcome: { kind: 'degraded', reason: 'test: claude not found' } };
  });
  const syncStep = vi.fn(async () => {
    ranSync.value = true;
    return { step: 11, outcome: { kind: 'completed' } };
  });
  const emitTelemetry = vi.fn();
  return { ranSync, degradedStep, syncStep, emitTelemetry };
});

vi.mock('../../src/lib/steps/index.js', () => ({
  STEPS: [
    { number: 9, fn: h.degradedStep, mutates: true, description: 'register plugin (degradable)' },
    { number: 11, fn: h.syncStep, mutates: true, description: 'first sync' },
  ],
}));
vi.mock('../../src/lib/api.js', () => ({ emitTelemetry: h.emitTelemetry }));
// Always-in-Claude-Code so the wrong-window gate passes deterministically.
vi.mock('../../src/lib/paste-detect.js', () => ({
  isInClaudeCodeContext: () => true,
  WRONG_WINDOW_COPY: '',
}));

import { runInit } from '../../src/lib/init-runner.js';
import { readSyncState } from '../../src/lib/sync-state.js';
import type { CommandContext } from '../../src/lib/context.js';

let rootDir: string;

function makeCtx(): CommandContext {
  return {
    apiBase: 'https://app.mysecond.ai',
    apiKey: 'msd_test',
    rootDir,
    silent: true,
    dryRun: false,
    forceUpdate: false,
    fix: false,
    resume: false,
    authOnly: false,
    pushAll: false,
    strategy: 'cloud-wins',
  } as unknown as CommandContext;
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'mysecond-runner-'));
  h.ranSync.value = false;
  h.degradedStep.mockClear();
  h.syncStep.mockClear();
  h.emitTelemetry.mockClear();
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe('init-runner: degraded step does not strand the customer', () => {
  it('continues to the first sync, exits 0, and does not ledger the degraded step', async () => {
    const exit = await runInit(makeCtx());

    // Install must NOT abort on a degraded registration.
    expect(exit).toBe(0);
    // The first-sync step MUST run after the degraded step.
    expect(h.syncStep).toHaveBeenCalledOnce();
    expect(h.ranSync.value).toBe(true);

    // Ledger: degraded step 9 NOT marked complete (re-runs next time); the
    // completed sync step 11 IS marked complete.
    const state = readSyncState(rootDir);
    expect(state.initCompletedSteps).not.toContain(9);
    expect(state.initCompletedSteps).toContain(11);
  });

  it('emits honest telemetry (step_degraded + completion carrying plugin_registered:false)', async () => {
    await runInit(makeCtx());

    const events = h.emitTelemetry.mock.calls.map((c) => ({ name: c[1], props: c[2] }));

    const degraded = events.find((e) => e.name === 'mysecond.init.step_degraded');
    expect(degraded).toBeTruthy();
    expect(degraded?.props.step_number).toBe(9);

    const completed = events.find((e) => e.name === 'mysecond.install.completed');
    expect(completed).toBeTruthy();
    expect(completed?.props.context_synced).toBe(true);
    expect(completed?.props.plugin_registered).toBe(false);
    expect(completed?.props.registration_degraded_reason).toBeTruthy();
  });
});
