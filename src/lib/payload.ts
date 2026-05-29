// Payload type definitions for the mysecond-app companion API.
// Mirrors GET /api/companion/cli-sync (down-sync) and POST /api/companion/artifacts.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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

export interface BasePluginFile {
  file_path: string;
  content: string;
  current_hash: string;
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
  // Workstream H: base plugin update payload. `base_plugin_version` is the
  // server's current HEAD SHA of mysecond-ai/product-manager-os; the cli
  // persists it after each successful sync. The `base_skills` / `base_agents`
  // / `base_workflows` arrays are present ONLY when the server determines the
  // client is behind. Each file_path is project-relative (e.g.
  // ".claude/skills/prd-generator/SKILL.md").
  base_plugin_version?: string | null;
  base_skills?: BasePluginFile[];
  base_agents?: BasePluginFile[];
  base_workflows?: BasePluginFile[];
  // Solo extensions (server authoritative; CLI sends nothing on cli-sync since
  // it's GET, but server may echo for debugging).
  workspace_scope?: 'solo' | 'team';
  customer_id?: string;
  // Workstream B Phase 2: per-user ordered list of on-disk @import paths for
  // this member's CLAUDE.md block (team-shared + product + personal, personal
  // last). Absent when the server predates Track B or for legacy API keys with
  // no member identity — sync degrades gracefully to leaving the block as-is.
  resolved_imports?: string[];
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

// Customs v1: provenance attribution on synced context_files rows. Receiver
// (mysecond-app /api/companion/files) persists this to the migration 058
// `authored_by` jsonb column. CAIO cardinality rule: prefer the Claude
// session id (`identity: <session-id>`); fall back to `${model}:${timestamp}`
// when CLAUDE_SESSION_ID isn't exported into the hook env. NEVER bare model
// name — model alone is low-cardinality and useless for attribution.
export interface AuthoredBy {
  kind: 'human' | 'ai' | 'services';
  source?: string;
  identity?: string;
}

export interface ContextFilePayload {
  file_path: string;
  content: string;
  current_hash: string;
  // Optional. Only stamped on customs paths (.claude/skills/*,
  // .claude/agents/*, .claude/workflows/*) today, where the receiver uses
  // it to segment the pm_os.sync_origin_created funnel. Receiver
  // normalizes unknown shapes to null.
  authored_by?: AuthoredBy;
}

export interface ContextFilesResponse {
  synced: number;
  skipped: number;
  errors: string[];
}

export interface ArtifactDir {
  relativeDir: string;
  type: ArtifactType;
}

// Skills under content/skills/*/SKILL.md are configured to write outputs to
// `work/<area>/outputs/…` for the four canonical activity areas (work/specs,
// work/discovery, work/strategy, work/launches). The `work/` prefix is
// canonical — skills that wrote to bare `specs/outputs/…` were the legacy
// pattern before the work/ activity-tree convention landed. Both prefixed
// and unprefixed variants are accepted so any legacy customer artifacts on
// disk keep syncing; canonical location is the work/ form.
//
// Note `work/launches/outputs` (plural) matches what skills emit. The legacy
// `launch/outputs` entry is a back-compat synonym.
//
// IMPORTANT: this list is a MAP of known paths to typed `artifact_type` values
// for the four configured areas. It is NOT an allowlist of "what paths sync."
// Any `work/<dir>/outputs/...md` path Claude writes to (even non-canonical
// areas like `work/product/outputs/...` that Claude may invent on its own)
// MUST sync — see classifyArtifactType + scanArtifacts below for the generic
// catch-all that handles non-canonical work areas with type='other'.
export const ARTIFACT_DIRS: readonly ArtifactDir[] = [
  // Canonical work/ activity-tree paths (what configured skills write today)
  { relativeDir: 'work/specs/outputs', type: 'prd' },
  { relativeDir: 'work/discovery/outputs', type: 'research' },
  { relativeDir: 'work/strategy/outputs', type: 'strategy' },
  { relativeDir: 'work/launches/outputs', type: 'launch' },
  // Legacy un-prefixed paths (back-compat)
  { relativeDir: 'specs/outputs', type: 'prd' },
  { relativeDir: 'discovery/outputs', type: 'research' },
  { relativeDir: 'strategy/outputs', type: 'strategy' },
  { relativeDir: 'launch/outputs', type: 'launch' },
  { relativeDir: 'analytics/outputs', type: 'analytics' },
];

export const CONTEXT_DIR = 'context';

// Server PER_FILE_LIMIT is 50KB. Pre-filter to skip wasted round-trips.
export const CONTEXT_PER_FILE_LIMIT = 50 * 1024;

// Server artifact cap is 500KB (mysecond-app /api/companion/artifacts rejects
// content > 500*1024). The scan skips anything larger client-side — both to
// avoid a guaranteed-reject round-trip and, critically, so the per-turn Stop
// sweep (`sync --push-only`) can't OOM/stall on a giant file. Mirrors
// CONTEXT_PER_FILE_LIMIT's role for context files.
export const ARTIFACT_PER_FILE_LIMIT = 500 * 1024;

// Filenames under context/ that are auto-generated metadata, not real context
// files. These must not sync to context_files. PMO-4: `index.md` is generated
// by various tools as a directory listing/index — treating it as user-edited
// context pollutes the server-side context_files table.
const EXCLUDED_CONTEXT_FILENAMES = new Set<string>(['index.md']);

// Classify a write event's file path as a context file. Same path-safety
// gate as classifyArtifactType — leading '/', traversal, absolute paths
// rejected. Only `.md` files under `context/` qualify; nested paths
// (e.g. context/personas/buyer.md) are supported.
//
// Case-insensitive prefix check: macOS APFS / Windows NTFS default to
// case-insensitive lookups, so `Context/foo.md` and `context/foo.md` resolve
// to the same file on disk. A skill that emits the wrong case must not
// silently drop on the floor — see follow-up #8 in mysecond-cli#11.
export function isContextFile(relativePath: string): boolean {
  if (relativePath.startsWith('/') || relativePath.includes('..')) return false;
  if (!relativePath.toLowerCase().startsWith(CONTEXT_DIR + '/')) return false;
  if (!relativePath.toLowerCase().endsWith('.md')) return false;

  // PMO-4: filter auto-generated index files; they're metadata, not context.
  const filename = relativePath.split('/').pop()?.toLowerCase();
  if (filename !== undefined && EXCLUDED_CONTEXT_FILENAMES.has(filename)) {
    return false;
  }

  return true;
}

// Customs v1: classify a write event's file path as a customer-authored
// skill / sub-agent / workflow artifact. These paths feed the Custom tab
// in Companion's /customize/* surfaces; the receiver detects origin
// ('created' | 'fork' | 'stock' | 'imported') from the slug + content hash.
//
// Matches:
//   .claude/skills/<slug>/SKILL.md           (and supporting *.md in the same dir)
//   .claude/agents/<name>.md                 (sub-agents live as flat files)
//   .claude/workflows/<slug>/*.md            (workflow steps live nested)
//
// Same path-safety gate as isContextFile / classifyArtifactType (no leading
// '/', no '..', case-insensitive prefix). Returns false for everything else
// so the dispatcher falls through to classifyArtifactType for legacy paths.
export function isCustomsArtifact(relativePath: string): boolean {
  if (relativePath.startsWith('/') || relativePath.includes('..')) return false;
  if (!relativePath.toLowerCase().endsWith('.md')) return false;
  const lower = relativePath.toLowerCase();
  // .claude/skills/<slug>/<file>.md — at least one segment under the slug dir.
  if (/^\.claude\/skills\/[^/]+\/[^/]+\.md$/.test(lower)) return true;
  // .claude/agents/<name>.md — flat under agents/.
  if (/^\.claude\/agents\/[^/]+\.md$/.test(lower)) return true;
  // .claude/workflows/<slug>/<file>.md — nested under workflow slug.
  if (/^\.claude\/workflows\/[^/]+\/[^/]+\.md$/.test(lower)) return true;
  return false;
}

// Build the AuthoredBy stamp for customs-artifact pushes. Reads from env
// vars Claude Code exports into hook subprocesses. CAIO cardinality rule:
//   - Prefer CLAUDE_SESSION_ID (high-cardinality, groups writes-per-session)
//   - Fall back to `${model}:${ISO timestamp}` when session id missing
//   - NEVER emit a bare model name (low cardinality, useless for attribution)
//
// Returns the same shape the receiver's normalizeAuthoredBy() expects.
export function buildAuthoredBy(): AuthoredBy {
  const sessionId = process.env.CLAUDE_SESSION_ID ?? '';
  if (sessionId.length > 0) {
    return { kind: 'ai', source: 'claude-code', identity: sessionId };
  }
  const model = process.env.CLAUDE_MODEL ?? 'claude-code';
  return {
    kind: 'ai',
    source: 'claude-code',
    identity: `${model}:${new Date().toISOString()}`,
  };
}

// Classify a write event's file path into an artifact_type for PostToolUse.
// Single source of truth — must agree with ARTIFACT_DIRS for the same paths or
// the same file gets typed differently depending on which sync path it took
// (PostToolUse single-file dispatch vs SessionStart full scan).
export function classifyArtifactType(relativePath: string): ArtifactType | null {
  if (relativePath.startsWith('/') || relativePath.includes('..')) return null;
  // Case-insensitive: same rationale as isContextFile — APFS/NTFS default
  // case-insensitive lookups must not produce silent drops.
  const lower = relativePath.toLowerCase();
  if (lower.includes('/tests/')) return null;
  if (!lower.endsWith('.md')) return null;
  // Match the canonical configured areas first to preserve their typed
  // semantics (prd/research/strategy/launch). ARTIFACT_DIRS order matters —
  // canonical work/ entries come before legacy unprefixed entries.
  for (const dir of ARTIFACT_DIRS) {
    if (lower.startsWith(dir.relativeDir.toLowerCase() + '/')) return dir.type;
  }
  // Generic catch-all for any non-canonical work area Claude writes to on its
  // own (e.g. work/product/outputs/release-notes.md, work/anything/outputs/x.md).
  // The configured skills only target the four canonical areas, but Claude can
  // and does invent its own folders during free-form work — those outputs MUST
  // still sync to the Companion so they're never silently dropped.
  if (/^work\/[^/]+\/outputs\//.test(lower)) return 'other';
  // Workflow outputs aren't in ARTIFACT_DIRS (they're scanned per-workflow not
  // per-tier), but the PostToolUse hook still classifies them.
  if (/^workflows\/[^/]+\/outputs\//.test(lower)) return 'other';
  return null;
}

// Walk ARTIFACT_DIRS under rootDir + discover any non-canonical
// `work/<area>/outputs/` folder Claude may have created on its own (e.g.
// `work/product/outputs/`). Produce payloads for every .md file.
// Pulled out of sync.ts so the artifact-source knowledge lives next to
// ARTIFACT_DIRS + classifyArtifactType.
//
// Discovery rule: any `work/<area>/outputs/` directory that exists on disk
// gets walked — typed via classifyArtifactType (canonical → real type;
// non-canonical → 'other'). Dedup'd against ARTIFACT_DIRS by relativeDir so
// the same canonical directory isn't walked twice.
export function scanArtifacts(rootDir: string): ArtifactPayload[] {
  const found: ArtifactPayload[] = [];
  const visited = new Set<string>();
  for (const entry of ARTIFACT_DIRS) {
    const dir = join(rootDir, entry.relativeDir);
    if (!existsSync(dir)) continue;
    walkArtifactDir(rootDir, dir, entry.type, found);
    visited.add(entry.relativeDir);
  }
  // Discover non-canonical `work/<area>/outputs/` directories on disk.
  const workRoot = join(rootDir, 'work');
  if (existsSync(workRoot)) {
    for (const areaEntry of readdirSync(workRoot, { withFileTypes: true })) {
      if (!areaEntry.isDirectory() || areaEntry.name.startsWith('.')) continue;
      const outputsRel = `work/${areaEntry.name}/outputs`;
      if (visited.has(outputsRel)) continue;
      const outputsDir = join(workRoot, areaEntry.name, 'outputs');
      if (!existsSync(outputsDir)) continue;
      walkArtifactDir(rootDir, outputsDir, 'other', found);
    }
  }
  return found;
}

// Walk context/ under rootDir and produce payloads for every .md file. Mirrors
// scanArtifacts but emits ContextFilePayload (no artifact_type / pm_name /
// skill_slug) and uses CONTEXT_DIR as the single root.
export function scanContextFiles(rootDir: string): ContextFilePayload[] {
  const found: ContextFilePayload[] = [];
  const dir = join(rootDir, CONTEXT_DIR);
  if (!existsSync(dir)) return found;
  walkContextDir(rootDir, dir, found);
  return found;
}

function walkContextDir(
  rootDir: string,
  currentDir: string,
  results: ContextFilePayload[]
): void {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    // Skip dotfiles/dotdirs — `.git/`, `.DS_Store`, scratch files like
    // `.notes.md` shouldn't leak to the server. Mirrors gitignore convention.
    if (entry.name.startsWith('.')) continue;
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walkContextDir(rootDir, fullPath, results);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    // PMO-4: skip auto-generated metadata files (mirrors isContextFile).
    if (EXCLUDED_CONTEXT_FILENAMES.has(entry.name.toLowerCase())) continue;

    let content: string;
    try {
      // stat first — readFileSync on a 500MB file would OOM the SessionStart
      // hook before the size check. Read only after we know the size is sane.
      const stat = statSync(fullPath);
      if (stat.size === 0 || stat.size > CONTEXT_PER_FILE_LIMIT) continue;
      content = readFileSync(fullPath, 'utf8');
    } catch {
      continue;
    }

    results.push({
      file_path: relative(rootDir, fullPath),
      content,
      current_hash: shortHash(content),
    });
  }
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

    let content: string;
    try {
      // stat first — a giant or transient artifact must not OOM or throw the
      // per-turn Stop sweep (mirrors walkContextDir). Skip empties and anything
      // over the server's artifact cap (it would be rejected server-side
      // anyway). A read error (file vanished mid-turn, permissions) is skipped,
      // never propagated — one bad file can't fail the whole push-only sweep.
      const stat = statSync(fullPath);
      if (stat.size === 0 || stat.size > ARTIFACT_PER_FILE_LIMIT) continue;
      content = readFileSync(fullPath, 'utf8');
    } catch {
      continue;
    }
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
