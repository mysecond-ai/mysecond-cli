// File utilities — sha256, safe path resolution, atomic-style local I/O.
//
// Ported from legacy v1.0.0 sync-context.js lines 213-273 + safePath hardening
// preserved from /simplify pass at commit 4d281e0 in this repo's git history.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function shortHash(content: string): string {
  return sha256(content).slice(0, 12);
}

// safePath — resolve a relative path under baseDir, refusing path traversal,
// absolute paths, and any resolved location that escapes baseDir.
//
// Threat model: server response includes a `file_path` like "context/company.md".
// A compromised or malicious server could return "../../../etc/passwd" or
// "/etc/passwd" — without this guard, writeLocalFile would happily clobber
// arbitrary files on the customer's machine.
export function safePath(baseDir: string, filePath: string): string | null {
  const normalized = normalize(filePath);
  if (isAbsolute(normalized) || normalized.startsWith('..') || normalized.includes('/../')) {
    return null;
  }
  const resolved = resolve(baseDir, normalized);
  // Final containment check: even after normalization, the resolved path must
  // live under baseDir. relative() returns a path that starts with '..' or is
  // absolute if it escapes.
  const rel = relative(baseDir, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return null;
  }
  return resolved;
}

export function readLocalFile(baseDir: string, filePath: string): string | null {
  const safe = safePath(baseDir, filePath);
  if (safe === null) return null;
  try {
    return readFileSync(safe, 'utf8');
  } catch {
    return null;
  }
}

export function writeLocalFile(baseDir: string, filePath: string, content: string): boolean {
  const safe = safePath(baseDir, filePath);
  if (safe === null) {
    process.stderr.write(`mysecond: skipped suspicious path: ${filePath}\n`);
    return false;
  }
  const dir = dirname(safe);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(safe, content);
  return true;
}

export function deleteLocalFile(baseDir: string, filePath: string): boolean {
  const safe = safePath(baseDir, filePath);
  if (safe === null) return false;
  try {
    unlinkSync(safe);
  } catch {
    return false;
  }
  // Clean up empty parent directories up to (but not including) baseDir.
  let dir = dirname(safe);
  while (dir !== baseDir && dir.startsWith(baseDir + '/')) {
    try {
      const entries = readdirSync(dir);
      if (entries.length > 0) break;
      rmdirSync(dir);
    } catch {
      break;
    }
    dir = dirname(dir);
  }
  return true;
}

export interface ProjectPaths {
  contextDir: string;
  skillsDir: string;
  agentsDir: string;
  workflowsDir: string;
  claudeMdPath: string;
  syncStatePath: string;
  conflictsDir: string;
}

export function projectPaths(rootDir: string): ProjectPaths {
  return {
    contextDir: join(rootDir, 'context'),
    skillsDir: join(rootDir, '.claude', 'skills'),
    agentsDir: join(rootDir, '.claude', 'agents'),
    workflowsDir: join(rootDir, 'workflows'),
    claudeMdPath: join(rootDir, 'CLAUDE.md'),
    syncStatePath: join(rootDir, '.claude', 'sync-state.json'),
    conflictsDir: join(rootDir, '.claude', 'sync-conflicts'),
  };
}
