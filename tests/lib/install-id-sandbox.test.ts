// Real-filesystem tests for getOrCreateInstallId's sandbox detection
// (review round 2 P3: the beacon tests mock the whole module — nothing
// exercised the actual EACCES capture or the clear-on-successful-read).
//
// POSIX-only: creates an unwritable fake $HOME (mode 0o500) so mkdirSync
// fails with a REAL EACCES. Windows perms work differently and the win32
// CI leg is advisory; skipped there.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getInstallIdWriteError,
  getOrCreateInstallId,
} from '../../src/lib/device-code.js';

const isWindows = process.platform === 'win32';

let originalHome: string | undefined;
let scratch: string;

beforeEach(() => {
  originalHome = process.env.HOME;
  scratch = mkdtempSync(join(tmpdir(), 'mysecond-install-id-'));
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  // Restore write perms so cleanup can delete.
  try {
    chmodSync(join(scratch, 'ro-home'), 0o700);
  } catch {
    // fine — dir may not exist in every test
  }
  rmSync(scratch, { recursive: true, force: true });
});

describe.skipIf(isWindows)('getOrCreateInstallId — real filesystem', () => {
  it('records EACCES when $HOME is unwritable, still returns an in-memory id', () => {
    const roHome = join(scratch, 'ro-home');
    mkdirSync(roHome);
    chmodSync(roHome, 0o500); // r-x: mkdir ~/.mysecond will EACCES
    process.env.HOME = roHome;

    const id = getOrCreateInstallId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(getInstallIdWriteError()?.code).toBe('EACCES');
  });

  it('clears the recorded error on a later successful read (no stale sandbox claim)', () => {
    // First: unwritable home records EACCES.
    const roHome = join(scratch, 'ro-home');
    mkdirSync(roHome);
    chmodSync(roHome, 0o500);
    process.env.HOME = roHome;
    getOrCreateInstallId();
    expect(getInstallIdWriteError()?.code).toBe('EACCES');

    // Then: a healthy home with a persisted id — the error must clear.
    const rwHome = join(scratch, 'rw-home');
    mkdirSync(join(rwHome, '.mysecond'), { recursive: true });
    writeFileSync(join(rwHome, '.mysecond', 'install-id'), 'persisted-id-123\n');
    process.env.HOME = rwHome;

    const id = getOrCreateInstallId();
    expect(id).toBe('persisted-id-123');
    expect(getInstallIdWriteError()).toBeNull();
  });

  it('persists and reuses the id on a healthy home', () => {
    const rwHome = join(scratch, 'rw-home');
    mkdirSync(rwHome, { recursive: true });
    process.env.HOME = rwHome;

    const first = getOrCreateInstallId();
    const second = getOrCreateInstallId();
    expect(second).toBe(first);
    expect(getInstallIdWriteError()).toBeNull();
  });
});
