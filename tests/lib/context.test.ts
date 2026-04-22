import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildContext, parseGlobalFlags } from '../../src/lib/context.js';

describe('parseGlobalFlags', () => {
  it('parses no args as defaults', () => {
    const f = parseGlobalFlags([]);
    expect(f.silent).toBe(false);
    expect(f.dryRun).toBe(false);
    expect(f.forceUpdate).toBe(false);
    expect(f.apiKey).toBeNull();
    expect(f.projectDir).toBeNull();
    expect(f.strategy).toBeNull();
    expect(f.positional).toEqual([]);
  });

  it('parses boolean flags', () => {
    const f = parseGlobalFlags(['--silent', '--dry-run', '--force-update']);
    expect(f.silent).toBe(true);
    expect(f.dryRun).toBe(true);
    expect(f.forceUpdate).toBe(true);
  });

  it('parses value flags', () => {
    const f = parseGlobalFlags(['--api-key', 'k', '--project-dir', '/p', '--strategy', 'cloud-wins']);
    expect(f.apiKey).toBe('k');
    expect(f.projectDir).toBe('/p');
    expect(f.strategy).toBe('cloud-wins');
  });

  it('throws on missing value for --api-key', () => {
    expect(() => parseGlobalFlags(['--api-key'])).toThrow('--api-key requires a value');
  });

  it('throws on invalid --strategy value', () => {
    expect(() => parseGlobalFlags(['--strategy', 'bogus'])).toThrow('--strategy must be one of');
  });

  it('collects positional args', () => {
    const f = parseGlobalFlags(['arg1', '--silent', 'arg2']);
    expect(f.positional).toEqual(['arg1', 'arg2']);
  });
});

describe('buildContext', () => {
  let savedHome: string | undefined;
  let savedKey: string | undefined;
  let savedUrl: string | undefined;
  let savedClaudeDir: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedKey = process.env.COMPANION_API_KEY;
    savedUrl = process.env.COMPANION_API_URL;
    savedClaudeDir = process.env.CLAUDE_PROJECT_DIR;
    delete process.env.COMPANION_API_KEY;
    delete process.env.COMPANION_API_URL;
    delete process.env.CLAUDE_PROJECT_DIR;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedKey === undefined) delete process.env.COMPANION_API_KEY;
    else process.env.COMPANION_API_KEY = savedKey;
    if (savedUrl === undefined) delete process.env.COMPANION_API_URL;
    else process.env.COMPANION_API_URL = savedUrl;
    if (savedClaudeDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = savedClaudeDir;
  });

  it('defaults apiBase to production', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mysecond-ctx-'));
    const ctx = buildContext(parseGlobalFlags(['--project-dir', tmp]));
    expect(ctx.apiBase).toBe('https://app.mysecond.ai');
  });

  it('reads apiKey + apiBase from .env in rootDir', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mysecond-ctx-'));
    writeFileSync(
      join(tmp, '.env'),
      'COMPANION_API_KEY=from-dotenv\nCOMPANION_API_URL=https://staging.mysecond.ai\n'
    );
    const ctx = buildContext(parseGlobalFlags(['--project-dir', tmp]));
    expect(ctx.apiKey).toBe('from-dotenv');
    expect(ctx.apiBase).toBe('https://staging.mysecond.ai');
  });

  it('--api-key flag wins over env', () => {
    process.env.COMPANION_API_KEY = 'from-env';
    const tmp = mkdtempSync(join(tmpdir(), 'mysecond-ctx-'));
    const ctx = buildContext(parseGlobalFlags(['--project-dir', tmp, '--api-key', 'from-flag']));
    expect(ctx.apiKey).toBe('from-flag');
  });

  it('strategy defaults to cloud-wins in --silent mode', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mysecond-ctx-'));
    const ctx = buildContext(parseGlobalFlags(['--project-dir', tmp, '--silent']));
    expect(ctx.strategy).toBe('cloud-wins');
    expect(ctx.silent).toBe(true);
  });

  it('--strategy flag wins over default', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mysecond-ctx-'));
    const ctx = buildContext(
      parseGlobalFlags(['--project-dir', tmp, '--silent', '--strategy', 'local-wins'])
    );
    expect(ctx.strategy).toBe('local-wins');
  });
});
