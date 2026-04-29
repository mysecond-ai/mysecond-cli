// File utilities — sha256, safe path resolution, atomic-style local I/O.

import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function shortHash(content: string): string {
  return sha256(content).slice(0, 12);
}

// safePath — resolve a relative path under baseDir, refusing path traversal,
// absolute paths, and any resolved location that escapes baseDir. Threat model:
// a compromised server returning "../../etc/passwd" or "/etc/passwd" would
// otherwise let writeLocalFile clobber arbitrary files.
export function safePath(baseDir: string, filePath: string): string | null {
  const normalized = normalize(filePath);
  if (isAbsolute(normalized) || normalized.startsWith('..') || normalized.includes('/../')) {
    return null;
  }
  const resolved = resolve(baseDir, normalized);
  const rel = relative(baseDir, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return null;
  }
  return resolved;
}

// Convert an absolute path back to a project-relative one if it lives inside
// rootDir. Returns null for paths outside the project tree, or for relative
// inputs that aren't already within a recognized project layout. Cross-platform
// safe via path.sep (no hardcoded '/').
export function relativeFromRoot(rootDir: string, filePath: string): string | null {
  if (filePath.startsWith(rootDir + sep) || filePath === rootDir) {
    return filePath.slice(rootDir.length + 1);
  }
  if (isAbsolute(filePath)) return null;
  // Relative input — accept as-is; downstream callers re-validate via safePath.
  return filePath;
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
  // mkdirSync({ recursive: true }) is a no-op if the directory exists; the
  // existsSync pre-check was redundant.
  mkdirSync(dirname(safe), { recursive: true });
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
  // Clean up empty parent directories up to (but not including) baseDir. Use
  // path.sep so the containment check works on Windows where sep === '\\'.
  let dir = dirname(safe);
  while (dir !== baseDir && dir.startsWith(baseDir + sep)) {
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
