// buildResumeCommand — the Step 2 hint must match HOW this process runs
// (install-wall plan): running version, never @latest; direct-node form when
// running from the fallback install path.

import { afterEach, describe, expect, it } from 'vitest';

import { __testing } from '../../src/lib/steps/step-15.js';

const { buildResumeCommand } = __testing;

const ORIGINAL_ARGV1 = process.argv[1];
const ORIGINAL_FALLBACK = process.env.MYSECOND_FALLBACK;

afterEach(() => {
  process.argv[1] = ORIGINAL_ARGV1;
  if (ORIGINAL_FALLBACK === undefined) delete process.env.MYSECOND_FALLBACK;
  else process.env.MYSECOND_FALLBACK = ORIGINAL_FALLBACK;
});

describe('buildResumeCommand', () => {
  it('echoes the RUNNING version via npx — never @latest (mid-publish drift guard)', () => {
    process.argv[1] = '/Users/pm/.npm/_npx/abc123/node_modules/.bin/mysecond';
    delete process.env.MYSECOND_FALLBACK;
    const cmd = buildResumeCommand('acme-x1');
    expect(cmd).toMatch(/^MYSECOND_CUSTOMER_SLUG=acme-x1 npx -y @mysecond\/cli@\d+\.\d+\.\d+ init --resume$/);
    expect(cmd).not.toContain('@latest');
  });

  it('echoes a QUOTED direct node invocation when running from the fallback install dir', () => {
    process.argv[1] = '/Users/pm/.mysecond/cli/1.11.0/mysecond-standalone.mjs';
    const cmd = buildResumeCommand('acme-x1');
    expect(cmd).toBe(
      'MYSECOND_CUSTOMER_SLUG=acme-x1 node "/Users/pm/.mysecond/cli/1.11.0/mysecond-standalone.mjs" init --resume'
    );
  });

  it('survives a home dir with SPACES (codex P1 — unquoted path split the command)', () => {
    process.argv[1] = '/Users/Ron Yang/.mysecond/cli/1.11.0/mysecond-standalone.mjs';
    const cmd = buildResumeCommand('acme-x1');
    expect(cmd).toContain('node "/Users/Ron Yang/.mysecond/cli/1.11.0/mysecond-standalone.mjs"');
  });

  it('does NOT treat nested cache paths under .mysecond/cli as the fallback (codex P2)', () => {
    process.argv[1] =
      '/Users/pm/.mysecond/cli/npm-cache/_npx/abc/node_modules/@mysecond/cli/bin/mysecond.cjs';
    delete process.env.MYSECOND_FALLBACK;
    const cmd = buildResumeCommand('acme-x1');
    expect(cmd).toContain('npx -y @mysecond/cli@');
    expect(cmd).not.toContain(' node ');
  });

  it('honors the MYSECOND_FALLBACK env override (set by install.sh)', () => {
    process.argv[1] = '/tmp/anywhere/mysecond-standalone.mjs';
    process.env.MYSECOND_FALLBACK = '1';
    const cmd = buildResumeCommand('acme-x1');
    expect(cmd).toBe(
      'MYSECOND_CUSTOMER_SLUG=acme-x1 node "/tmp/anywhere/mysecond-standalone.mjs" init --resume'
    );
  });

  it('detects the fallback dir with Windows path separators', () => {
    process.argv[1] = 'C:\\Users\\pm\\.mysecond\\cli\\1.11.0\\mysecond-standalone.mjs';
    delete process.env.MYSECOND_FALLBACK;
    const cmd = buildResumeCommand('acme-x1');
    expect(cmd).toContain('node "C:\\Users\\pm\\.mysecond\\cli\\1.11.0\\mysecond-standalone.mjs"');
  });
});
