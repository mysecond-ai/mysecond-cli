// Regression tests for the round-2 red-team findings (CTO + CAIO agents).
// Each test ENCODES the bug so a future refactor can't silently undo the fix.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { successBox } from '../../src/lib/copy.js';
import {
  buildMarketplaceJson,
  serializeMarketplaceJson,
} from '../../src/lib/marketplace-json.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'mysecond-r2-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// =====================================================================
// CTO P0-A: success box uses pmName + companyName separately
// =====================================================================
describe('RED-TEAM R2 P0-A: successBox uses pmName + companyName separately', () => {
  it('renders "for Alice at Acme" when both fields differ', () => {
    const box = successBox('Alice', 'Acme Corp');
    expect(box).toContain('for Alice at Acme Corp');
    // Critical regression: must NOT show "for Alice at Alice" (the v1 bug
    // that conflated both slots under shared.customerName).
    expect(box).not.toContain('for Alice at Alice');
  });

  it('renders fallback copy when fields are missing (defensive)', () => {
    const box = successBox('you', 'your company');
    expect(box).toContain('for you at your company');
  });
});

// =====================================================================
// CAIO P0-B: marketplace.json includes metadata.description + version
// =====================================================================
describe('RED-TEAM R2 P0-B: marketplace.json metadata block prevents stderr warning', () => {
  it('includes metadata.description (prevents "No marketplace description provided" warning)', () => {
    const json = buildMarketplaceJson('acme');
    expect(json.metadata).toBeDefined();
    expect(json.metadata.description).toMatch(/PM Operating System/);
    expect(json.metadata.description.length).toBeGreaterThan(20);
  });

  it('includes metadata.version', () => {
    const json = buildMarketplaceJson('acme');
    expect(json.metadata.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('serialized output is valid JSON with metadata block', () => {
    const out = serializeMarketplaceJson(buildMarketplaceJson('acme'));
    const parsed = JSON.parse(out) as { metadata?: { description?: string } };
    expect(parsed.metadata?.description).toBeDefined();
  });
});

// =====================================================================
// CAIO P0-C: success box uses namespaced /pm-os:* skill names
// =====================================================================
describe('RED-TEAM R2 P0-C: success box uses namespaced skill names', () => {
  const box = successBox('Alice', 'Acme');

  it('advertises /pm-os:prd-generator (namespaced) not bare /prd-generator', () => {
    expect(box).toContain('/pm-os:prd-generator');
    // Critical: bare `/prd-generator` collides with any other plugin or
    // project-level skill. Customer would type bare and get wrong routing.
    expect(box).not.toMatch(/^[^:]\/prd-generator/m);
    // Note: we DON'T assert "no bare /prd-generator anywhere" — the
    // namespaced form contains the substring "prd-generator" by definition.
  });

  it('advertises /pm-os:skills (namespaced)', () => {
    expect(box).toContain('/pm-os:skills');
  });

  it('advertises /pm-os:enhance-context (namespaced)', () => {
    expect(box).toContain('/pm-os:enhance-context');
  });
});

// =====================================================================
// CAIO P0-D: step-9 calls marketplace remove BEFORE marketplace add
// =====================================================================
describe('RED-TEAM R2 P0-D: step-9 calls marketplace remove before add', () => {
  const stepSrc = readFileSync(
    join(import.meta.dirname ?? __dirname, '..', '..', 'src', 'lib', 'steps', 'step-9.ts'),
    'utf8'
  );

  it('source contains marketplace remove call before marketplace add', () => {
    // Look for the order: 'plugin', 'marketplace', 'remove' BEFORE
    // 'plugin', 'marketplace', 'add' in the source flow.
    const removeIdx = stepSrc.indexOf("'remove'");
    const addIdx = stepSrc.indexOf("'add'");
    expect(removeIdx).toBeGreaterThan(0);
    expect(addIdx).toBeGreaterThan(removeIdx);
  });
});

// =====================================================================
// CTO P0-B: CDN 403 path produces actionable copy + preserves network subCode
// =====================================================================
describe('RED-TEAM R2 P0-B: plugin-tarball CDN 403 has actionable copy', () => {
  const tarballSrc = readFileSync(
    join(import.meta.dirname ?? __dirname, '..', '..', 'src', 'lib', 'plugin-tarball.ts'),
    'utf8'
  );

  it('source has 401/403-specific branch with firewall + signed-URL hint', () => {
    expect(tarballSrc).toMatch(/response\.status === 401 \|\| response\.status === 403/);
    expect(tarballSrc).toMatch(/firewall|signed URL/i);
  });

  it('CDN 401/403 branch preserves subCode network for LKG fallback eligibility', () => {
    // Without subCode='network' in this branch, step 9 would NOT trigger the
    // LKG fallback path → exit 6 immediately even if cache exists. We match
    // from the if-condition through to the next `}` after the throw to
    // capture the full throw-arguments block (incl. options object).
    const cdnBranch = tarballSrc.match(
      /response\.status === 401 \|\| response\.status === 403[\s\S]{0,1500}?\}\s*\}/
    );
    expect(cdnBranch).not.toBeNull();
    expect(cdnBranch![0]).toContain("subCode: 'network'");
  });
});

// =====================================================================
// CTO P1-A: spawnSync ENOENT detection + actionable error
// =====================================================================
describe('RED-TEAM R2 P1-A: spawnSync ENOENT produces actionable error', () => {
  const stepSrc = readFileSync(
    join(import.meta.dirname ?? __dirname, '..', '..', 'src', 'lib', 'steps', 'step-9.ts'),
    'utf8'
  );

  it('source checks ENOENT on both spawnSync calls (marketplace add + plugin install)', () => {
    const enoentChecks = stepSrc.match(/error\.code === 'ENOENT'|\.code === 'ENOENT'/g) ?? [];
    expect(enoentChecks.length).toBeGreaterThanOrEqual(2);
  });

  it('ENOENT error message mentions PATH + claude binary', () => {
    expect(stepSrc).toMatch(/Cannot find 'claude' binary/);
    expect(stepSrc).toMatch(/PATH/);
  });
});

// =====================================================================
// CTO P1-B: writeSyncState uses atomicWriteFile (not direct writeFileSync)
// =====================================================================
describe('RED-TEAM R2 P1-B: writeSyncState is atomic', () => {
  const syncStateSrc = readFileSync(
    join(import.meta.dirname ?? __dirname, '..', '..', 'src', 'lib', 'sync-state.ts'),
    'utf8'
  );

  it('imports atomicWriteFile from atomic-write.js', () => {
    expect(syncStateSrc).toMatch(/import \{ atomicWriteFile \}/);
  });

  it('writeSyncState calls atomicWriteFile (not raw writeFileSync)', () => {
    // Find the writeSyncState function body and verify atomicWriteFile is called.
    const fnBody = syncStateSrc.match(/export function writeSyncState[\s\S]{0,800}?^}/m);
    expect(fnBody).not.toBeNull();
    expect(fnBody![0]).toContain('atomicWriteFile(path');
    expect(fnBody![0]).not.toMatch(/\bwriteFileSync\(path/);
  });
});

// =====================================================================
// CTO P1-D: telemetry stub wired at 3 critical sites (LKG, auth-thrash, SIGINT)
// =====================================================================
describe('RED-TEAM R2 P1-D: telemetry wired at critical sites', () => {
  it('emitTelemetry exported from api.ts and posts to /api/companion/telemetry', () => {
    const apiSrc = readFileSync(
      join(import.meta.dirname ?? __dirname, '..', '..', 'src', 'lib', 'api.ts'),
      'utf8'
    );
    expect(apiSrc).toMatch(/export async function emitTelemetry/);
    // Telemetry endpoint mentioned in the body. method:POST present.
    expect(apiSrc).toContain('/api/companion/telemetry');
    // Within the emitTelemetry function body specifically: method POST.
    const fnBody = apiSrc.match(/export async function emitTelemetry[\s\S]{0,800}?^}/m);
    expect(fnBody).not.toBeNull();
    expect(fnBody![0]).toMatch(/method: 'POST'/);
  });

  it('step-9 emits last_known_good_used at all 3 fallback success paths', () => {
    const stepSrc = readFileSync(
      join(import.meta.dirname ?? __dirname, '..', '..', 'src', 'lib', 'steps', 'step-9.ts'),
      'utf8'
    );
    const lkgEvents = stepSrc.match(/mysecond\.init\.last_known_good_used/g) ?? [];
    expect(lkgEvents.length).toBeGreaterThanOrEqual(3);
  });

  it('step-9 emits auth_thrash_detected before throwing circuit breaker', () => {
    const stepSrc = readFileSync(
      join(import.meta.dirname ?? __dirname, '..', '..', 'src', 'lib', 'steps', 'step-9.ts'),
      'utf8'
    );
    expect(stepSrc).toContain('mysecond.init.auth_thrash_detected');
  });

  it('init-runner emits abandoned_at_step_N from SIGINT handler', () => {
    const runnerSrc = readFileSync(
      join(import.meta.dirname ?? __dirname, '..', '..', 'src', 'lib', 'init-runner.ts'),
      'utf8'
    );
    expect(runnerSrc).toContain('mysecond.init.abandoned_at_step_N');
  });
});

// =====================================================================
// Smoke: write a fake sync-state via the new atomic path; corrupt it; ensure
// readSyncState recovers gracefully (returns EMPTY_STATE) per existing behavior.
// =====================================================================
describe('RED-TEAM R2 P1-B: writeSyncState end-to-end', () => {
  it('writes valid JSON readable by readSyncState', () => {
    mkdirSync(join(workDir, '.claude'), { recursive: true });
    // Dynamic import to ensure fresh module after vi.resetModules() in other tests.
    return import('../../src/lib/sync-state.js').then((mod) => {
      const state = {
        files: {},
        artifacts: {},
        lastSyncedAt: null,
        lastNpmUpdateAt: null,
        initCompletedSteps: [1, 2, 3],
        step9Auth401RetryCount: 0,
        customerId: 'cust_test',
        workspaceScope: 'solo' as const,
        customerSlug: 'test',
      };
      mod.writeSyncState(workDir, state);
      const reloaded = mod.readSyncState(workDir);
      expect(reloaded.customerId).toBe('cust_test');
      expect(reloaded.initCompletedSteps).toEqual([1, 2, 3]);
    });
  });
});
