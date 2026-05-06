// Tests for step-13 — Workstream B Day 5+ Item 5B.
//
// Step 13 prints the framed success box AND emits the install_completed
// JSON status event. This file pins the event content + shape.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { step13 } from '../../src/lib/steps/step-13.js';
import { setSilentMode } from '../../src/lib/silent-status.js';
import type { CommandContext } from '../../src/lib/context.js';
import type { StepContext } from '../../src/lib/steps/types.js';

function makeContext(opts: {
  silent: boolean;
  userEmail?: string;
  pmName?: string;
  companyName?: string;
}): StepContext {
  const ctx: CommandContext = {
    apiBase: 'https://app.mysecond.ai',
    apiKey: 'msd_test',
    rootDir: '/tmp/test',
    silent: opts.silent,
    dryRun: false,
    forceUpdate: false,
    fix: false,
    resume: false,
    strategy: 'cloud-wins',
  };
  return {
    ctx,
    state: {} as never,
    shared: {
      pmName: opts.pmName,
      companyName: opts.companyName,
      userEmail: opts.userEmail,
      pluginCounts: { skills: 91, agents: 6, workflows: 4 },
    },
  };
}

describe('step-13: install_completed JSON status event', () => {
  let stdoutWrites: string[] = [];
  let originalStdoutWrite: typeof process.stdout.write;

  beforeEach(() => {
    stdoutWrites = [];
    originalStdoutWrite = process.stdout.write;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdoutWrites.push(chunk.toString());
      return true;
    }) as any;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    setSilentMode(false);
  });

  it('emits install_completed event with installCompleteClaudeMessage(email) when email is known', async () => {
    setSilentMode(true);
    const sctx = makeContext({
      silent: true,
      userEmail: 'ron@mysecond.ai',
      pmName: 'Ron',
      companyName: 'mySecond',
    });
    await step13(sctx);

    // Find the JSON-shaped install_completed event in stdout writes.
    const jsonLines = stdoutWrites.filter((s) => s.startsWith('{'));
    const events = jsonLines.map((line) => JSON.parse(line));
    const completed = events.find(
      (e: { kind?: string }) => e.kind === 'install_completed',
    );

    expect(completed).toBeTruthy();
    expect(completed.message).toContain('## mySecond installed');
    expect(completed.message).toContain('Connected as: ron@mysecond.ai');
    expect(completed.message).toContain('/mysecond:welcome');
    expect(completed.message).toContain('mysecond doctor');
    expect(completed.skills_installed).toBe(91);
    expect(completed.agents_installed).toBe(6);
    expect(completed.workflows_installed).toBe(4);
    expect(completed.mysecond_status_protocol_version).toBe(1);
    // Protocol contract: `at` must be an ISO 8601 timestamp.
    expect(completed.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('falls back to "you" when shared.userEmail is missing', async () => {
    setSilentMode(true);
    const sctx = makeContext({
      silent: true,
      userEmail: undefined,
      pmName: 'You',
      companyName: 'your company',
    });
    await step13(sctx);

    const jsonLines = stdoutWrites.filter((s) => s.startsWith('{'));
    const events = jsonLines.map((line) => JSON.parse(line));
    const completed = events.find(
      (e: { kind?: string }) => e.kind === 'install_completed',
    );

    expect(completed).toBeTruthy();
    expect(completed.message).toContain('Connected as: you');
  });

  it('emits install_completed to stdout even in non-silent (interactive) mode', async () => {
    setSilentMode(false);
    const sctx = makeContext({
      silent: false,
      userEmail: 'ron@mysecond.ai',
      pmName: 'Ron',
      companyName: 'mySecond',
    });
    await step13(sctx);

    // install_completed must appear in stdout regardless of silentMode —
    // it is the deterministic done-signal for the chat assistant.
    const allOutput = stdoutWrites.join('');
    const jsonLines = stdoutWrites.filter((s) => s.trim().startsWith('{'));
    const events = jsonLines.map((line) => JSON.parse(line.trim()));
    const completed = events.find(
      (e: { kind?: string }) => e.kind === 'install_completed',
    );
    expect(completed).toBeTruthy();
    expect(completed.mysecond_status_protocol_version).toBe(1);
    // Count fields must be wired on the non-silent path too.
    expect(completed.skills_installed).toBe(91);
    expect(completed.agents_installed).toBe(6);
    expect(completed.workflows_installed).toBe(4);

    // install_started must NOT appear in interactive mode (emitStatus is still
    // silent-only — only install_completed bypasses the gate).
    const started = events.find(
      (e: { kind?: string }) => e.kind === 'install_started',
    );
    expect(started).toBeUndefined();

    // The framed success box still prints in interactive mode.
    expect(allOutput).toContain('mySecond PM OS installed');
  });

  it('still completes the step (returns kind: completed) regardless of email', async () => {
    setSilentMode(false);
    const sctx = makeContext({
      silent: true,
      userEmail: undefined,
    });
    const result = await step13(sctx);
    expect(result.outcome.kind).toBe('completed');
    expect(result.step).toBe(13);
  });
});
