// Payload type definitions for the mysecond-app companion API.
//
// Mirrors the wire format of GET /api/companion/cli-sync (down-sync) and
// POST /api/companion/artifacts (up-sync). Solo extensions per EDD §5.2.

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
  // Solo extensions (server authoritative; CLI sends nothing on this endpoint
  // since it's GET, but server may echo for debugging).
  workspace_scope?: 'solo' | 'team';
  customer_id?: string;
}

export interface ArtifactPayload {
  file_path: string;
  content: string;
  current_hash: string;
  artifact_type: 'prd' | 'research' | 'strategy' | 'launch' | 'analytics' | 'other';
  pm_name: string | null;
  skill_slug: string | null;
  produced_at: string;
}

export interface ArtifactsResponse {
  synced: number;
}

// Artifact source dirs — same as legacy ARTIFACT_DIRS (sync-context.js:400-406).
// Subdirectories of these get scanned recursively for .md files.
export interface ArtifactDir {
  relativeDir: string;
  type: ArtifactPayload['artifact_type'];
}

export const ARTIFACT_DIRS: readonly ArtifactDir[] = [
  { relativeDir: 'specs/outputs', type: 'prd' },
  { relativeDir: 'discovery/outputs', type: 'research' },
  { relativeDir: 'strategy/outputs', type: 'strategy' },
  { relativeDir: 'launch/outputs', type: 'launch' },
  { relativeDir: 'analytics/outputs', type: 'analytics' },
];

// Classify a write event's file path into an artifact_type for PostToolUse.
// Returns null when the path is not a tracked artifact location.
export function classifyArtifactType(
  relativePath: string
): ArtifactPayload['artifact_type'] | null {
  if (relativePath.startsWith('/') || relativePath.includes('..')) return null;
  if (relativePath.includes('/tests/')) return null;
  if (relativePath.startsWith('specs/outputs/')) return 'prd';
  if (relativePath.startsWith('strategy/outputs/')) return 'strategy';
  if (relativePath.startsWith('discovery/outputs/')) return 'research';
  if (relativePath.startsWith('launch/outputs/')) return 'launch';
  if (relativePath.startsWith('analytics/outputs/')) return 'other';
  if (/^workflows\/[^/]+\/outputs\//.test(relativePath)) return 'other';
  return null;
}
