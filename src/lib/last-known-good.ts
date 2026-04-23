// Last-known-good plugin cache per EDD §6.2.B (Decision 0-C guardrail #3 / CRO).
// Cache validated extracted plugin contents to
// `~/.mysecond/cache/last-known-good/customer-{slug}/v{version}/`. On step-9
// failure with cache present, fall back to cached version, emit telemetry,
// print stale-cache banner, exit 0.

import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  lastKnownGoodCustomerRoot,
  lastKnownGoodIndexPath,
  lastKnownGoodVersionDir,
} from './mysecond-paths.js';

const MAX_CACHED_VERSIONS = 3;

interface CacheEntry {
  version: string;
  cached_at: string;
  sha256: string;
}

interface CacheIndex {
  // keyed by `customer-{slug}` per spec §6.2.B
  [key: string]: CacheEntry[];
}

function readIndex(): CacheIndex {
  const path = lastKnownGoodIndexPath();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as CacheIndex;
  } catch {
    return {};
  }
}

function writeIndex(index: CacheIndex): void {
  const path = lastKnownGoodIndexPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(index, null, 2) + '\n');
}

// Cache the extracted plugin tree after a successful step 9 sub-step (f)
// completion. cpSync is cross-platform per guardrail #4 (no shell `cp`).
export function cacheLastKnownGood(
  slug: string,
  version: string,
  sha256: string,
  sourceDir: string
): void {
  const destDir = lastKnownGoodVersionDir(slug, version);
  // Atomic: copy to `.tmp`, rename. Acceptable to skip true atomicity here
  // since cache writes happen post-success — failure leaves the cache in a
  // recoverable state (next install re-caches).
  const tmpDest = destDir + '.tmp';
  rmSync(tmpDest, { recursive: true, force: true });
  cpSync(sourceDir, tmpDest, { recursive: true });
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(dirname(destDir), { recursive: true });
  // Move the tmp into place. cpSync + rename is one option; here we cpSync
  // twice (tmp → final) and remove tmp. Less efficient but cross-platform safe
  // when destination dir's parent might be a fresh mkdir. Trade ~10ms for
  // simplicity.
  cpSync(tmpDest, destDir, { recursive: true });
  rmSync(tmpDest, { recursive: true, force: true });

  // Update index + evict oldest if >MAX_CACHED_VERSIONS.
  const index = readIndex();
  const key = `customer-${slug}`;
  const existing = index[key] ?? [];
  // Remove any prior entry for this version (re-cache replaces).
  const filtered = existing.filter((e) => e.version !== version);
  filtered.push({ version, cached_at: new Date().toISOString(), sha256 });

  // Evict oldest by `cached_at` if over limit.
  filtered.sort((a, b) => a.cached_at.localeCompare(b.cached_at));
  while (filtered.length > MAX_CACHED_VERSIONS) {
    const oldest = filtered.shift();
    if (oldest === undefined) break;
    rmSync(lastKnownGoodVersionDir(slug, oldest.version), {
      recursive: true,
      force: true,
    });
  }

  index[key] = filtered;
  writeIndex(index);
}

export interface LastKnownGoodHit {
  version: string;
  cached_at: string;
  cached_age_hours: number;
  source_dir: string;
}

// Look up the most recent cached version for this customer, or null if none.
export function findLastKnownGood(slug: string): LastKnownGoodHit | null {
  const index = readIndex();
  const key = `customer-${slug}`;
  const entries = index[key] ?? [];
  if (entries.length === 0) return null;

  // Sort by cached_at descending and pick the newest.
  const sorted = [...entries].sort((a, b) => b.cached_at.localeCompare(a.cached_at));
  const newest = sorted[0];
  if (newest === undefined) return null;

  const sourceDir = lastKnownGoodVersionDir(slug, newest.version);
  if (!existsSync(sourceDir)) {
    // Index entry orphaned — cache dir was manually deleted. Treat as miss.
    return null;
  }

  const ageMs = Date.now() - new Date(newest.cached_at).getTime();
  const ageHours = Math.max(0, Math.round(ageMs / (1000 * 60 * 60)));

  return {
    version: newest.version,
    cached_at: newest.cached_at,
    cached_age_hours: ageHours,
    source_dir: sourceDir,
  };
}

// Purge ALL cached versions for a customer — called from step 4 when
// install-ready returns `access_revoked` (CRO mitigation per §6.2.B).
export function purgeLastKnownGood(slug: string): void {
  const customerRoot = lastKnownGoodCustomerRoot(slug);
  rmSync(customerRoot, { recursive: true, force: true });

  const index = readIndex();
  const key = `customer-${slug}`;
  if (index[key] !== undefined) {
    delete index[key];
    writeIndex(index);
  }
}

export const __testing = { MAX_CACHED_VERSIONS };
