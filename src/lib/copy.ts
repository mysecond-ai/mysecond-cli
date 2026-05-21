// Customer-facing copy strings — finalized per EDD §6.6 / §6.7 / §6.8 / §6.9.
// All paste-ready; snapshot-tested in §6.10 to prevent silent drift.

import { WRONG_WINDOW_COPY } from './paste-detect.js';

export { WRONG_WINDOW_COPY };

// §6.7 SIGINT message (CXO-3 — drop "step N+1" engineer-speak).
export const SIGINT_MESSAGE =
  'Interrupted. Your progress was saved — re-run `mysecond init` to pick up where we left off.';

// §6.6 install-ready status copy. 7 statuses + ready:true success path.
export const STATUS_COPY = {
  provisioning: 'Building your PM OS…',
  regen_queued: 'Your PM OS is queued to build…',
  regen_in_progress: 'Your PM OS is being generated…',
  re_provisioning: (customerName: string): string =>
    `Welcome back, ${customerName}. Restoring your PM OS — your context, skills, and artifacts are all still here.`,
  regen_failed: (customerId: string): string =>
    `Something went wrong rebuilding your PM OS.\n\n  customer_id: ${customerId}\n\nEmail support@mysecond.ai with that reference. We'll respond within 4 business hours.`,
  access_revoked: (customerId: string): string =>
    `Your mySecond access was revoked. If this is unexpected, email support@mysecond.ai with customer_id=${customerId}. Otherwise manage billing at mysecond.ai/billing.`,
  schema_drift:
    "mySecond is updating to match Claude Code's latest release. We're on it — this usually takes under 30 min. Come back and re-run `mysecond init`, or watch mysecond.ai/status for the all-clear.",
  poll_timeout:
    "Your PM OS is still being built. Re-run `mysecond init` in 60s — it's almost certainly ready by then.",
} as const;

// §6.6a mid-poll copy transitions — cycle the spinner copy by elapsed-time
// bucket so a 60s wait doesn't feel frozen.
export function midPollCopy(elapsedMs: number, baseStatus: 'regen_in_progress' | 're_provisioning' | 'provisioning' | 'regen_queued'): string {
  if (baseStatus === 're_provisioning') {
    if (elapsedMs < 10_000) return 'Restoring your PM OS…';
    if (elapsedMs < 25_000) return 'Still restoring — compiling your skills.';
    if (elapsedMs < 45_000) return 'Still restoring — publishing to the registry.';
    return 'Almost there — finalizing.';
  }
  if (baseStatus === 'regen_in_progress') {
    if (elapsedMs < 10_000) return 'Building your PM OS…';
    if (elapsedMs < 25_000) return 'Still building — compiling your skills.';
    if (elapsedMs < 45_000) return 'Still building — publishing to the registry.';
    return 'Almost there — finalizing.';
  }
  // For provisioning + regen_queued (faster statuses), use first-bucket only.
  return baseStatus === 'provisioning'
    ? STATUS_COPY.provisioning
    : STATUS_COPY.regen_queued;
}

// Default @import list for init-time CLAUDE.md generation (no resolved set yet).
// Order matters: company → product → personas → competitors → goals.
// personalization.md is deliberately absent — it only exists after /welcome or
// /personalize-mysecond runs, and the server signals its presence via
// resolved_imports on the first sync that returns it.
export const DEFAULT_CLAUDE_MD_IMPORTS: readonly string[] = [
  'context/company.md',
  'context/product.md',
  'context/personas.md',
  'context/competitors.md',
];

// Validate a single @import path before it is rendered into CLAUDE.md.
//
// Codex P1 — `resolved_imports` is server-provided; a hostile or malformed
// entry could (a) inject newlines / extra instructions into CLAUDE.md, or
// (b) point outside the project via `../` or an absolute path. An `@import`
// path is rendered raw into CLAUDE.md, so it MUST be tightly constrained.
//
// Accepts ONLY: project-relative paths under `context/`, ending in `.md`,
// with no control characters, no whitespace, no `..` traversal, no absolute
// paths, no backslashes. Anything else is rejected and the caller drops it.
export function isValidImportPath(p: unknown): p is string {
  if (typeof p !== 'string') return false;
  if (p.length === 0 || p.length > 512) return false;
  // Reject control chars (incl. newlines, CR, tab, NUL, ESC) and all whitespace.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7F-\x9F]/.test(p)) return false;
  // Reject absolute paths (POSIX `/`, Windows `C:\`) and backslashes.
  if (p.startsWith('/') || p.includes('\\')) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  // Reject `..` traversal in any path segment.
  if (p.split('/').some((seg) => seg === '..')) return false;
  // Must be under context/ and end in .md.
  if (!p.startsWith('context/')) return false;
  if (!p.endsWith('.md')) return false;
  // Reject `@` so an entry can't break out of the rendered `@import` line.
  if (p.includes('@')) return false;
  return true;
}

// §6.7a canonical CLAUDE.md block (v1.4 @import requirement).
// `@context/*.md` triggers Claude Code's @import — materializes file contents
// into auto-loaded session context at next session start.
//
// Pass `imports` to override the default list (used by sync's
// `regenerateMysecondBlock` when the server returns `resolved_imports`).
// Init callers omit `imports` and receive the DEFAULT_CLAUDE_MD_IMPORTS list.
//
// Codex P1: every import path is validated via `isValidImportPath` before
// being rendered. Invalid entries are silently dropped here; callers that
// want to warn should pre-filter with `isValidImportPath` and report.
export function claudeMdBlock(
  companyName: string,
  pmName: string,
  imports: readonly string[] = DEFAULT_CLAUDE_MD_IMPORTS
): string {
  const importLines = imports.filter(isValidImportPath).map((p) => `@${p}`);
  return [
    `# mySecond PM OS — ${companyName}`,
    '',
    `This workspace has a mySecond PM OS installed for ${pmName} at ${companyName}.`,
    '',
    "Context files are auto-loaded into Claude's context at session start via `@import`:",
    '',
    ...importLines,
    '',
    'For skill usage, type `/skills` in Claude Code. Sync runs automatically on every SessionStart.',
    '',
    '## File-Write Rule (load-bearing — sync depends on it)',
    '',
    'When saving files in this workspace, ALWAYS use the `Write` tool (or `Edit` / `MultiEdit` for in-place updates). Never use bash heredoc (`cat > file <<EOF`), `echo > file`, `printf >`, `tee`, or any shell redirect to a project path. The PostToolUse sync hook only fires on `Write|Edit|MultiEdit` — bash file-writes silently skip artifact sync, so the file never reaches mySecond. A PreToolUse hook also enforces this; bash redirects to `context/`, `work/`, or `.claude/{skills,agents,workflows}/` will be blocked with a clear error.',
    '',
    '## After Installation',
    '',
    'After running `mysecond init`, the only next step for a new user is `/welcome`. Do not suggest `/enhance-context`, `/prd-generator`, or other skills before `/welcome` runs — no context files exist yet, and those skills depend on them. Stay quiet about skill discovery; let `/welcome` drive the first-run experience.',
    '',
    'If summarizing the install confirmation, mention ONLY the three counts the cli printed in its success box (skills, sub-agents, workflows). Do NOT invent or add additional totals (e.g., "N skills synced from mysecond.ai") — those server-side numbers double-count internal entities and will mislead the user.',
  ].join('\n');
}

// Build a set of [start, end) character ranges that are inside fenced code
// blocks (``` ... ``` — at least three backticks at the start of a line).
// An unterminated fence extends to end-of-file. Used to ignore marker strings
// that merely appear as documentation inside a code example.
function fencedCodeRanges(base: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  // Match a fence line: optional leading whitespace, then >=3 backticks.
  const fenceRe = /^[ \t]*`{3,}.*$/gm;
  let openIdx: number | null = null;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(base)) !== null) {
    if (openIdx === null) {
      openIdx = match.index;
    } else {
      // Close the fence — range covers the opening fence through the end of
      // the closing fence line.
      ranges.push([openIdx, match.index + match[0].length]);
      openIdx = null;
    }
  }
  // Unterminated fence — everything from the opener to EOF is "inside code".
  if (openIdx !== null) {
    ranges.push([openIdx, base.length]);
  }
  return ranges;
}

function isInsideRanges(idx: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => idx >= start && idx < end);
}

// Find every occurrence of `marker` in `base` that is NOT inside a fenced
// code block.
function findMarkerIndices(
  base: string,
  marker: string,
  fenced: Array<[number, number]>
): number[] {
  const indices: number[] = [];
  let from = 0;
  for (;;) {
    const idx = base.indexOf(marker, from);
    if (idx === -1) break;
    if (!isInsideRanges(idx, fenced)) indices.push(idx);
    from = idx + marker.length;
  }
  return indices;
}

// Splice a `block` between `startMarker` and `endMarker` in `base`.
//
// Fail-closed contract (plan § Track C):
//   - Exactly one start marker and exactly one end marker must be present, with
//     the start marker appearing BEFORE the end marker. Any other configuration
//     (markers absent, duplicated, nested, or reversed) is treated as corrupt
//     and returns `null` — the caller must leave the file untouched and warn.
//   - Codex P2: marker occurrences INSIDE a fenced code block (``` ... ```) are
//     ignored — a CLAUDE.md that merely documents the markers in an example must
//     not have its content overwritten. After filtering out fenced occurrences,
//     the exactly-one-start-then-one-end rule still applies (fail closed).
//   - On sync we NEVER append; we only re-splice inside an existing pair.
//     Appending on sync would duplicate the block on every session start for a
//     customer who deleted the markers intentionally.
//
// Returns the new file string on success, or `null` on any marker anomaly.
export function spliceBetweenMarkers(
  base: string,
  startMarker: string,
  endMarker: string,
  block: string
): string | null {
  const fenced = fencedCodeRanges(base);
  const startIndices = findMarkerIndices(base, startMarker, fenced);
  const endIndices = findMarkerIndices(base, endMarker, fenced);

  // Exactly one start and exactly one end (after ignoring fenced occurrences).
  if (startIndices.length !== 1 || endIndices.length !== 1) return null;

  const firstStart = startIndices[0]!;
  const firstEnd = endIndices[0]!;

  // Reversed (end before start) or overlapping.
  if (firstEnd <= firstStart) return null;

  const markedBlock = `${startMarker}\n${block}\n${endMarker}`;
  return (
    base.slice(0, firstStart) +
    markedBlock +
    base.slice(firstEnd + endMarker.length)
  );
}

export const CLAUDE_MD_MARKER_START = '<!-- mysecond-start -->';
export const CLAUDE_MD_MARKER_END = '<!-- mysecond-end -->';

// CAIO #6 (Workstream B Phase 2a Day 4): the EPHEMERAL install-completion
// message Claude Code surfaces in chat after the --silent cli exits. This
// is DISTINCT from the persistent claudeMdBlock above (which lives in
// CLAUDE.md and contains @import + skill-discovery instructions).
//
// The 3-line spec is locked: any change requires CAIO review. Stay under
// 1KB total — Anthropic enforces a 10,000-char cap on additionalContext/
// systemMessage/stdout per code.claude.com/docs/en/hooks. Single
// interpolation: `<email>`. NO other variables.
//
// Emitted by the cli's install_completed JSON status event (Day 5 wiring)
// or surfaced via the SessionStart hook on first post-install session.
export function installCompleteClaudeMessage(email: string): string {
  return [
    '## mySecond installed',
    `- Connected as: ${email}`,
    '- Run /mysecond:welcome to set up your PM Operating System.',
    '- Run mysecond doctor if anything looks off.',
  ].join('\n');
}

// §6.8 post-install success message (May-2026 redesign per launch-feedback-log).
// Plain-text, single primary CTA = `/welcome`. Drops premature suggestions for
// /prd-generator + /enhance-context (customer has no context files yet).
//
// Inputs: {pm_name}, {company_name}, plugin counts (skills/agents/workflows).
// All inputs are SANITIZED — see sanitizeName() — to defend against malicious
// customer/company names from the install-ready response (HTML, ANSI escapes,
// control chars, length blowup).

const NAME_MAX_LEN = 40;

// Sanitize an arbitrary server-provided name string for safe inclusion in the
// success message. Strips control chars + ANSI/CSI escapes, collapses
// whitespace, truncates. Returns the fallback if the result is empty.
function sanitizeName(input: string | undefined | null, fallback: string): string {
  if (input === undefined || input === null) return fallback;
  if (typeof input !== 'string') return fallback;
  // Strip ASCII control chars (0x00-0x1F, 0x7F) — covers \r, \n, \t, ESC (0x1B),
  // backspace, bell, etc. ANSI/CSI escape sequences start with ESC so removing
  // ESC neutralizes them. Also strip C1 control range (0x80-0x9F).
  // eslint-disable-next-line no-control-regex
  let s = input.replace(/[\x00-\x1F\x7F-\x9F]/g, "").replace(/[<>]/g, "");
  // Collapse internal whitespace runs to single spaces; trim ends.
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length === 0) return fallback;
  if (s.length > NAME_MAX_LEN) {
    s = s.slice(0, NAME_MAX_LEN - 1) + '…';
  }
  return s;
}

export interface PostInstallCounts {
  skills: number;
  agents: number;
  workflows: number;
}

// Build the count line, omitting zero-count categories so a partially-empty
// plugin doesn't print "0 sub-agents". If all three are zero (extraction
// folder unreadable), fall back to a generic phrasing.
function formatCountsLine(counts: PostInstallCounts | undefined): string {
  const skills = counts?.skills ?? 0;
  const agents = counts?.agents ?? 0;
  const workflows = counts?.workflows ?? 0;
  const parts: string[] = [];
  if (skills > 0) parts.push(`${skills} ${skills === 1 ? 'skill' : 'skills'}`);
  if (agents > 0) parts.push(`${agents} ${agents === 1 ? 'sub-agent' : 'sub-agents'}`);
  if (workflows > 0) parts.push(`${workflows} ${workflows === 1 ? 'workflow' : 'workflows'}`);
  if (parts.length === 0) {
    return '- pm-os plugin registered with your PM skill library';
  }
  return `- pm-os plugin registered with ${parts.join(', ')}`;
}

// New post-install message (May-2026 redesign). Returns a plain-text block
// (NOT a framed ASCII box). Caller adds surrounding blank lines.
//
// Customer feedback drove the rewrite:
//   1. "Bring in the company name to make it feel more personal" → lead line
//      personalizes with both pmName and companyName.
//   2. "Improve the messaging — kick off the welcome flow OR ask me to" →
//      single primary CTA = `/welcome` (not `/prd-generator`, which is
//      premature without context files).
//   3. Plugin still requires Claude Code restart to load → keep the
//      "ALMOST THERE" technical instruction.
export function successBox(
  pmName: string,
  companyName: string,
  counts?: PostInstallCounts,
  isInvitedPm: boolean = false
): string {
  const pm = sanitizeName(pmName, 'you');
  const company = sanitizeName(companyName, 'your company');

  // Invited-PM variant: the Head-of-Product (HoP) already ran /welcome and
  // built the team context. An invited PM landing here has already had their
  // context synced (step 11), so running /welcome would be redundant.
  // Point them at /personalize-mysecond — the dedicated member-onboarding
  // skill that creates their personal context file (Track D contract).
  if (isInvitedPm) {
    const skills = counts?.skills ?? 0;
    const agents = counts?.agents ?? 0;
    const workflows = counts?.workflows ?? 0;
    const lines = [
      `✓ mySecond PM OS installed for ${pm} at ${company}`,
      '',
      `Installation complete. ${skills} ${skills === 1 ? 'skill' : 'skills'}, ${agents} ${agents === 1 ? 'sub-agent' : 'sub-agents'}, and ${workflows} ${workflows === 1 ? 'workflow' : 'workflows'} are installed, and your context synced successfully.`,
      '',
      'Quit and reopen Claude Code to load mySecond, then run /personalize-mysecond to set up your personal PM context.',
      '',
      'Need help? Reply at hello@mysecond.ai or open mysecond.ai/dashboard',
    ];
    return lines.join('\n');
  }

  const lines = [
    `✓ mySecond PM OS installed for ${pm} at ${company}`,
    '',
    "Here's what's now in place:",
    formatCountsLine(counts),
    '- Context sync hooks active for every Claude Code session',
    '- Your context files will be created in step 2 below',
    '',
    'Install complete. Quit and reopen Claude Code to load mySecond.',
    '',
    `Then run /welcome in Claude Code. It takes about 5 minutes and sets up your context files for ${company} (company, product, personas, competitors, goals).`,
    '',
    'After /welcome, your full skill library — PRDs, roadmaps, research syntheses, and 80+ more — knows your team and product.',
    '',
    'Need help? Reply at hello@mysecond.ai or open mysecond.ai/dashboard',
  ];
  return lines.join('\n');
}

// §6.2.B last-known-good stale-cache banner.
export function staleCacheBanner(cachedAgeHours: number): string {
  return [
    `⚠️  Couldn't reach mysecond.ai right now — your PM OS is running on the last validated version (cached ${cachedAgeHours}h ago).`,
    'Your context, skills, and sync hooks all work normally. We\'ll auto-retry the update on your next Claude Code session.',
  ].join('\n');
}

// §6.5 --fix prompt copy (truncated key display, "Overwrite" verb, [y/N] default-N).
export function fixPromptEnvConflict(currentValue: string, newValue: string): string {
  const mask = (s: string): string => {
    if (s.length <= 9) return s;
    return s.slice(0, 6) + '…' + s.slice(-3);
  };
  return [
    'Your .env already has COMPANION_API_KEY set to a different value:',
    '',
    `  Current:  COMPANION_API_KEY=${mask(currentValue)}`,
    `  New:      COMPANION_API_KEY=${mask(newValue)}`,
    '',
    'Overwrite your existing value? [y/N] (auto-N in 30s)',
  ].join('\n');
}
