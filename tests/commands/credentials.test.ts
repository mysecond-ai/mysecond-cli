// Tests for `mysecond credentials print` — the single credential resolver the
// base-plugin sync hook calls. Pure: runCredentials reads ctx.apiKey/apiBase
// (already resolved by buildContext) and prints, so no fetch/keychain mocking.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runCredentials } from '../../src/commands/credentials.js';
import type { CommandContext } from '../../src/lib/context.js';

function ctx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    apiBase: 'https://app.mysecond.ai',
    apiKey: 'msd_abcdefghijklmnopqrstuvwxyz',
    rootDir: '/tmp/proj',
    silent: true,
    dryRun: false,
    forceUpdate: false,
    fix: false,
    resume: false,
    authOnly: false,
    pushAll: false,
    strategy: 'cloud-wins',
    ...overrides,
  };
}

describe('mysecond credentials print', () => {
  let out: string;
  let err: string;
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    out = '';
    err = '';
    outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
      out += String(s);
      return true;
    });
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => {
      err += String(s);
      return true;
    });
  });

  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('masks the token by default and prints the URL', async () => {
    const code = await runCredentials([], ctx());
    expect(code).toBe(0);
    expect(out).toContain('COMPANION_API_KEY=msd_abcdefgh…wxyz');
    expect(out).toContain('COMPANION_API_URL=https://app.mysecond.ai');
    // never leak the full token in masked mode
    expect(out).not.toContain('msd_abcdefghijklmnopqrstuvwxyz');
  });

  it('emits the plaintext token SHELL-QUOTED with --plaintext (safe to source)', async () => {
    const code = await runCredentials(['print', '--plaintext'], ctx());
    expect(code).toBe(0);
    // Single-quoted so a value with shell metacharacters can't execute on source.
    expect(out).toContain("COMPANION_API_KEY='msd_abcdefghijklmnopqrstuvwxyz'");
    expect(out).toContain("COMPANION_API_URL='https://app.mysecond.ai'");
  });

  it('escapes a single quote in a value for safe sourcing', async () => {
    const code = await runCredentials(['print', '--plaintext'], ctx({ apiKey: "ab'cd" }));
    expect(code).toBe(0);
    // POSIX: ' -> '\'' so the assignment stays a single safe token.
    expect(out).toContain("COMPANION_API_KEY='ab'\\''cd'");
  });

  it("rejects an unknown action without printing the credential", async () => {
    const code = await runCredentials(['dump', '--plaintext'], ctx());
    expect(code).toBe(2);
    expect(err).toContain("unknown action 'dump'");
    expect(out).toBe('');
  });

  it('exits 1 with guidance when no credential is resolved', async () => {
    const code = await runCredentials(['print', '--plaintext'], ctx({ apiKey: '' }));
    expect(code).toBe(1);
    expect(err).toContain('no credential found');
    expect(out).toBe('');
  });
});
