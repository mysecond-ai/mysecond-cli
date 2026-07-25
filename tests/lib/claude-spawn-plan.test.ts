// buildClaudeSpawnPlan — the pure spawn-plan builder behind spawnClaude
// (win32 triage group G / PR 4).
//
// Node >=18.20/20.12 throws EINVAL when spawnSync targets a .cmd/.bat
// without shell:true (CVE-2024-27980 mitigation), and npm-shim Windows
// installs resolve `claude.cmd` — before spawnClaude, EVERY plugin
// register/install/uninstall spawn failed on such machines (step-9 could
// strand the install; prune swallowed the EINVAL silently). The platform is
// injectable so BOTH branches are pinned from any OS; the win32 CI run
// additionally executes the real shell path via the .cmd fixtures in
// prune-stale-plugins.test.ts.

import { describe, expect, it } from 'vitest';
import { buildClaudeSpawnPlan } from '../../src/lib/claude-bin.js';

const ARGS = ['plugin', 'install', 'pm-os@mysecond-customer-acme', '--scope', 'user'];

describe('buildClaudeSpawnPlan', () => {
  it('POSIX: direct spawn, no shell, args untouched — on every binary shape', () => {
    for (const bin of ['/usr/local/bin/claude', '/home/u/.local/bin/claude', 'claude']) {
      expect(buildClaudeSpawnPlan(bin, ARGS, 'linux')).toEqual({
        command: bin,
        args: ARGS,
        shell: false,
      });
    }
  });

  it('win32 + .exe or bare name: still direct spawn (only cmd/bat shims need the shell)', () => {
    for (const bin of ['C:\\bin\\claude.exe', 'claude']) {
      const plan = buildClaudeSpawnPlan(bin, ARGS, 'win32');
      expect(plan.shell).toBe(false);
      expect(plan.args).toEqual(ARGS);
    }
  });

  it('win32 + .cmd/.bat (any case): shell spawn', () => {
    for (const bin of ['C:\\npm\\claude.cmd', 'C:\\npm\\claude.CMD', 'C:\\npm\\claude.bat']) {
      expect(buildClaudeSpawnPlan(bin, ARGS, 'win32').shell).toBe(true);
    }
  });

  it('win32 shell path: the COMMAND is ALWAYS quoted; space/metachar args are quoted too', () => {
    // Stack review P1: an unquoted C:\\Users\\R&D\\...\\claude.cmd splits at
    // `&` in cmd.exe. Quoting neutralizes & | < > ^ ( ) inside double quotes.
    const plan = buildClaudeSpawnPlan(
      'C:\\Users\\Ron Yang\\AppData\\npm\\claude.cmd',
      ['plugin', 'marketplace', 'add', 'C:\\Users\\Ron Yang\\.mysecond\\marketplace', '--scope', 'user'],
      'win32',
    );
    expect(plan.command).toBe('"C:\\Users\\Ron Yang\\AppData\\npm\\claude.cmd"');
    expect(plan.args).toEqual([
      'plugin',
      'marketplace',
      'add',
      '"C:\\Users\\Ron Yang\\.mysecond\\marketplace"',
      '--scope',
      'user',
    ]);
    // No-space command still quoted; clean args stay bare.
    const bare = buildClaudeSpawnPlan('C:\\npm\\claude.cmd', ['plugin', 'install', 'pm-os@m'], 'win32');
    expect(bare.command).toBe('"C:\\npm\\claude.cmd"');
    expect(bare.args).toEqual(['plugin', 'install', 'pm-os@m']);
  });

  it('win32 shell path: legal metachar-bearing PATHS work — quoted, not refused', () => {
    // Stack review P1: refusing % ! & rejected real Windows profile dirs
    // (C:\\Users\\R&D, C:\\Users\\100% Ron). Quoting handles them.
    const plan = buildClaudeSpawnPlan(
      'C:\\Users\\R&D\\npm\\claude.cmd',
      ['plugin', 'marketplace', 'add', 'C:\\Users\\100% Ron\\.mysecond\\marketplace', '--scope', 'user'],
      'win32',
    );
    expect(plan.command).toBe('"C:\\Users\\R&D\\npm\\claude.cmd"');
    expect(plan.args[3]).toBe('"C:\\Users\\100% Ron\\.mysecond\\marketplace"');
  });

  it('win32 shell path REFUSES the unquotables — double quote and CR/LF (injection primitives; NTFS forbids " in paths)', () => {
    for (const evil of ['a"b', 'a\rb', 'a\nb']) {
      expect(() =>
        buildClaudeSpawnPlan('C:\\npm\\claude.cmd', ['plugin', 'install', evil], 'win32'),
      ).toThrow(/unquotable/);
    }
    expect(() =>
      buildClaudeSpawnPlan('C:\\np"m\\claude.cmd', ['plugin', 'install', 'x'], 'win32'),
    ).toThrow(/unquotable/);
  });

  it('win32 shell path: an empty arg becomes "" instead of vanishing from the cmd line', () => {
    const plan = buildClaudeSpawnPlan('C:\\npm\\claude.cmd', ['plugin', ''], 'win32');
    expect(plan.args).toEqual(['plugin', '""']);
  });

  it('POSIX never rejects or quotes anything (no shell involved — args go straight to execve)', () => {
    for (const arg of ['a&b', 'a"b', 'a\nb']) {
      const plan = buildClaudeSpawnPlan('/usr/bin/claude', ['plugin', 'install', arg], 'linux');
      expect(plan.args[2]).toBe(arg);
      expect(plan.shell).toBe(false);
    }
  });
});
