// Payload type definitions for the mysecond-app companion API.
// Mirrors GET /api/companion/cli-sync (down-sync) and POST /api/companion/artifacts.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

import { shortHash } from './files.js';

export const ARTIFACT_TYPES = [
  'prd',
  'research',
  'strategy',
  'launch',
  'analytics',
  'other',
] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export interface ContextFile {
  file_path: string;
  content: string;
  current_hash: string;
}

export interface CompanionFile {
  file_path: string;
  content: string;
}

export interface CliSyncResponse {
  // Server may return either shape (legacy `files` or current `context_files`).
  context_files?: ContextFile[];
  files?: ContextFile[];
  custom_skills?: CompanionFile[];
  custom_agents?: CompanionFile[];
  custom_workflows?: CompanionFile[];
  claude_md_override?: string | null;
  deleted_paths?: string[];
  syncedAt: string;
  // Solo extensions (server authoritative; CLI sends nothing on cli-sync since
  // it's GET, but server may echo for debugging).
  workspace_scope?: 'solo' | 'team';
  customer_id?: string;
}

export interface ArtifactPayload {
  file_path: string;
  content: string;
  current_hash: string;
  artifact_type: ArtifactType;
  pm_name: string | null;
  skill_slug: string | null;
  produced_at: string;
}

export interface ArtifactsResponse {
  synced: number;
}

export interface ArtifactDir {
  relativeDir: string;
  type: ArtifactType;
}

export const ARTIFACT_DIRS: readonly ArtifactDir[] = [
  { relativeDir: 'specs/outputs', type: 'prd' },
  { relativeDir: 'discovery/outputs', type: 'research' },
  { relativeDir: 'strategy/outputs', type: 'strategy' },
  { relativeDir: 'launch/outputs', type: 'launch' },
  { relativeDir: 'analytics/outputs', type: 'analytics' },
];

// Classify a write event's file path into an artifact_type for PostToolUse.
// Single source of truth — must agree with ARTIFACT_DIRS for the same paths or
// the same file gets typed differently depending on which sync path it took
// (PostToolUse single-file dispatch vs SessionStart full scan).
export function classifyArtifactType(relativePath: string): ArtifactType | null {
  if (relativePath.startsWith('/') || relativePath.includes('..')) return null;
  if (relativePath.includes('/tests/')) return null;
  for (const dir of ARTIFACT_DIRS) {
    if (relativePath.startsWith(dir.relativeDir + '/')) return dir.type;
  }
  // Workflow outputs aren't in ARTIFACT_DIRS (they're scanned per-workflow not
  // per-tier), but the PostToolUse hook still classifies them.
  if (/^workflows\/[^/]+\/outputs\//.test(relativePath)) return 'other';
  return null;
}

// Walk ARTIFACT_DIRS under rootDir and produce payloads for every .md file.
// Pulled out of sync.ts so the artifact-source knowledge lives next to
// ARTIFACT_DIRS + classifyArtifactType.
export function scanArtifacts(rootDir: string): ArtifactPayload[] {
  const found: ArtifactPayload[] = [];
  for (const entry of ARTIFACT_DIRS) {
    const dir = join(rootDir, entry.relativeDir);
    if (!existsSync(dir)) continue;
    walkArtifactDir(rootDir, dir, entry.type, found);
  }
  return found;
}

function walkArtifactDir(
  rootDir: string,
  currentDir: string,
  artifactType: ArtifactType,
  results: ArtifactPayload[]
): void {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walkArtifactDir(rootDir, fullPath, artifactType, results);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

    const content = readFileSync(fullPath, 'utf8');
    const relativePath = relative(rootDir, fullPath);
    const parentDir = basename(currentDir);
    const pmNameMatch = parentDir.match(/^\d{4}-\d{2}-\d{2}-\d{4}-(.+)$/);
    const pmName = pmNameMatch && pmNameMatch[1] !== undefined ? pmNameMatch[1] : null;
    const skillSlug = entry.name
      .replace(/^\d{4}-\d{2}-\d{2}-\d{4}-/, '')
      .replace(/\.md$/, '');
    results.push({
      file_path: relativePath,
      content,
      current_hash: shortHash(content),
      artifact_type: artifactType,
      pm_name: pmName,
      skill_slug: skillSlug.length > 0 ? skillSlug : null,
      produced_at: new Date().toISOString(),
    });
  }
}
