import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Cross-platform fake home for tests (win32 triage group B, 2026-07).
 *
 * `os.homedir()` reads HOME on POSIX but USERPROFILE on win32 — tests that
 * set only `process.env.HOME` sandboxed nothing on Windows: fixtures landed
 * in the REAL runner home (32 failures across 4 suites, plus silent
 * cross-file pollution in two suites that "passed"). Set/restore BOTH.
 *
 * Usage inside beforeEach/afterEach:
 *   let fake: FakeHome;
 *   beforeEach(() => { fake = installFakeHome(); });
 *   afterEach(() => { fake.restore(); });
 * `fake.home` is the sandboxed home dir (already created).
 */
export interface FakeHome {
  home: string;
  restore: () => void;
}

export function installFakeHome(prefix = 'mysecond-home-', homeDir?: string): FakeHome {
  const home = homeDir ?? join(mkdtempSync(join(tmpdir(), prefix)), 'home');
  mkdirSync(home, { recursive: true });
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return {
    home,
    restore() {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedProfile;
    },
  };
}
