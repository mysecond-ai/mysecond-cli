// Tests for readTeamIdFromCreds — the `mysecond sync` command's local read of
// MYSECOND_TEAM_ID from the project-scoped credentials file (P1, mysecond-app#257).
//
// Isolates HOME per test so ~/.mysecond/projects/ writes don't escape into the
// real user dir — mirrors the step-5b.test.ts pattern.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readTeamIdFromCreds } from '../../src/commands/sync.js';
import {
  getProjectScopedCredsDir,
  getProjectScopedCredsPath,
} from '../../src/lib/creds-path.js';

let originalHome: string;
let tmpHome: string;
let projectDir: string;

beforeEach(() => {
  originalHome = process.env.HOME ?? homedir();
  tmpHome = mkdtempSync(join(tmpdir(), 'cli-team-id-home-'));
  process.env.HOME = tmpHome;
  projectDir = mkdtempSync(join(tmpdir(), 'cli-team-id-proj-'));
});

afterEach(() => {
  process.env.HOME = originalHome;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {}
  try {
    rmSync(projectDir, { recursive: true, force: true });
  } catch {}
});

function writeCreds(content: string): void {
  const dir = getProjectScopedCredsDir(projectDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(getProjectScopedCredsPath(projectDir), content);
}

describe('readTeamIdFromCreds', () => {
  it('returns the team id when the creds file has a MYSECOND_TEAM_ID line', () => {
    writeCreds(
      'COMPANION_API_KEY=key123\n' +
        'COMPANION_API_URL=https://app.mysecond.ai\n' +
        'MYSECOND_TEAM_ID=e8c3e0ac-f1c2-45f9-b614-f5c63c995a6a\n'
    );
    expect(readTeamIdFromCreds(projectDir)).toBe(
      'e8c3e0ac-f1c2-45f9-b614-f5c63c995a6a'
    );
  });

  it('returns null when the creds file has no MYSECOND_TEAM_ID line (Solo / team owner / upgrade customer)', () => {
    writeCreds(
      'COMPANION_API_KEY=key123\nCOMPANION_API_URL=https://app.mysecond.ai\n'
    );
    expect(readTeamIdFromCreds(projectDir)).toBeNull();
  });

  it('returns null when the creds file does not exist', () => {
    expect(readTeamIdFromCreds(projectDir)).toBeNull();
  });

  it('strips surrounding quotes and whitespace from the value', () => {
    writeCreds('MYSECOND_TEAM_ID="team-quoted-42"\n');
    expect(readTeamIdFromCreds(projectDir)).toBe('team-quoted-42');
  });

  it('returns null when MYSECOND_TEAM_ID is present but empty', () => {
    writeCreds('COMPANION_API_KEY=key123\nMYSECOND_TEAM_ID=\n');
    expect(readTeamIdFromCreds(projectDir)).toBeNull();
  });
});
