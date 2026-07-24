// Runner-level beacon emission locks (install-wall plan).
//
// The three behaviors that make the failing 56% visible:
//   1. wrong-window exit-2 AWAITS a `wrong_window` beacon (exit paths must
//      not fire-and-forget — the process dies before delivery)
//   2. `cli_started` fires in EVERY mode INCLUDING --auth-only (the authed
//      install.started is guarded off there, which is exactly why Step 1 of
//      the two-command paste was invisible)
//   3. EACCES/EPERM persisting the install-id beacons `sandbox_suspected`
//
// Same harness pattern as init-runner-degraded.test.ts: real runInit, stubbed
// STEPS, temp sync-state.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const inClaudeCode = { value: true };
  const emitBeacon = vi.fn(async () => undefined);
  const emitTelemetry = vi.fn();
  const installIdWriteError = { value: null as NodeJS.ErrnoException | null };
  const step = vi.fn(async () => ({ step: 15, outcome: { kind: 'completed' as const } }));
  return { inClaudeCode, emitBeacon, emitTelemetry, installIdWriteError, step };
});

vi.mock('../../src/lib/steps/index.js', () => ({
  STEPS: [{ number: 15, fn: h.step, mutates: true, description: 'device-code OAuth' }],
}));
vi.mock('../../src/lib/api.js', () => ({ emitTelemetry: h.emitTelemetry }));
vi.mock('../../src/lib/beacon.js', () => ({
  emitBeacon: h.emitBeacon,
}));
vi.mock('../../src/lib/paste-detect.js', () => ({
  isInClaudeCodeContext: () => h.inClaudeCode.value,
  WRONG_WINDOW_COPY: 'wrong window',
}));
vi.mock('../../src/lib/device-code.js', () => ({
  getOrCreateInstallId: () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  getInstallIdWriteError: () => h.installIdWriteError.value,
}));

import { runInit } from '../../src/lib/init-runner.js';
import type { CommandContext } from '../../src/lib/context.js';

let rootDir: string;

function makeCtx(overrides: Record<string, unknown> = {}): CommandContext {
  return {
    apiBase: 'https://app.mysecond.ai',
    apiKey: '',
    rootDir,
    silent: true,
    dryRun: false,
    forceUpdate: false,
    fix: false,
    resume: false,
    authOnly: false,
    pushAll: false,
    strategy: 'cloud-wins',
    ...overrides,
  } as unknown as CommandContext;
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'mysecond-beacons-'));
  h.inClaudeCode.value = true;
  h.installIdWriteError.value = null;
  h.emitBeacon.mockClear();
  h.emitTelemetry.mockClear();
  h.step.mockClear();
  delete process.env.MYSECOND_CUSTOMER_SLUG;
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
  delete process.env.MYSECOND_CUSTOMER_SLUG;
});

describe('runInit beacons', () => {
  it('wrong-window exit 2 emits (and awaits) a wrong_window beacon with the slug', async () => {
    h.inClaudeCode.value = false;
    process.env.MYSECOND_CUSTOMER_SLUG = 'acme-corp-a3f2';
    // Prove the AWAIT: the beacon promise resolves late; runInit must not
    // return before it settles.
    let beaconSettled = false;
    h.emitBeacon.mockImplementation(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            beaconSettled = true;
            resolve();
          }, 30)
        ) as Promise<undefined>
    );
    const code = await runInit(makeCtx());
    expect(code).toBe(2);
    expect(beaconSettled).toBe(true)
    expect(h.emitBeacon).toHaveBeenCalledTimes(1);
    expect(h.emitBeacon.mock.calls[0][0]).toMatchObject({
      stage: 'wrong_window',
      slug: 'acme-corp-a3f2',
      installId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    });
    expect(h.step).not.toHaveBeenCalled();
  });

  it('cli_started fires in --auth-only mode (where install.started is guarded off)', async () => {
    process.env.MYSECOND_CUSTOMER_SLUG = 'acme-corp-a3f2';
    const code = await runInit(makeCtx({ authOnly: true }));
    expect(code).toBe(0);
    // install.started must NOT fire in auth-only (existing funnel contract)…
    expect(h.emitTelemetry).not.toHaveBeenCalledWith(
      expect.anything(),
      'mysecond.install.started',
      expect.anything()
    );
    // …but the unauthed beacon MUST.
    const stages = h.emitBeacon.mock.calls.map((c) => (c[0] as { stage: string }).stage);
    expect(stages).toContain('cli_started');
  });

  it('cli_started omits the slug when none is known (never sends "unknown")', async () => {
    await runInit(makeCtx());
    const started = h.emitBeacon.mock.calls.find(
      (c) => (c[0] as { stage: string }).stage === 'cli_started'
    );
    expect(started).toBeDefined();
    expect((started![0] as { slug?: string }).slug).toBeUndefined();
  });

  it('EACCES persisting the install-id beacons sandbox_suspected', async () => {
    const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
    err.code = 'EACCES';
    h.installIdWriteError.value = err;
    await runInit(makeCtx());
    const stages = h.emitBeacon.mock.calls.map((c) => (c[0] as { stage: string }).stage);
    expect(stages).toContain('sandbox_suspected');
    const sandbox = h.emitBeacon.mock.calls.find(
      (c) => (c[0] as { stage: string }).stage === 'sandbox_suspected'
    );
    expect((sandbox![0] as { errorClass?: string }).errorClass).toBe('EACCES');
  });

  it('non-permission write failures (e.g. ENOSPC) do NOT claim sandbox', async () => {
    const err = new Error('ENOSPC') as NodeJS.ErrnoException;
    err.code = 'ENOSPC';
    h.installIdWriteError.value = err;
    await runInit(makeCtx());
    const stages = h.emitBeacon.mock.calls.map((c) => (c[0] as { stage: string }).stage);
    expect(stages).not.toContain('sandbox_suspected');
  });
});
