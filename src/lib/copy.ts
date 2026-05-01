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

// §6.7a canonical CLAUDE.md block (v1.4 @import requirement).
// `@context/*.md` triggers Claude Code's @import — materializes file contents
// into auto-loaded session context at next session start.
export function claudeMdBlock(companyName: string, pmName: string): string {
  return [
    `# mySecond PM OS — ${companyName}`,
    '',
    `This workspace has a mySecond PM OS installed for ${pmName} at ${companyName}.`,
    '',
    "Context files are auto-loaded into Claude's context at session start via `@import`:",
    '',
    '@context/company.md',
    '@context/product.md',
    '@context/personas.md',
    '@context/competitors.md',
    '',
    'For skill usage, type `/skills` in Claude Code. Sync runs automatically on every SessionStart.',
    '',
    '## After Installation',
    '',
    'After running `mysecond init`, the only next step for a new user is `/welcome`. Do not suggest `/enhance-context`, `/prd-generator`, or other skills before `/welcome` runs — no context files exist yet, and those skills depend on them. Stay quiet about skill discovery; let `/welcome` drive the first-run experience.',
  ].join('\n');
}

export const CLAUDE_MD_MARKER_START = '<!-- mysecond-start -->';
export const CLAUDE_MD_MARKER_END = '<!-- mysecond-end -->';

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
  counts?: PostInstallCounts
): string {
  const pm = sanitizeName(pmName, 'you');
  const company = sanitizeName(companyName, 'your company');
  const lines = [
    `✓ mySecond PM OS installed for ${pm} at ${company}`,
    '',
    "Here's what's now in place:",
    formatCountsLine(counts),
    '- Context sync hooks active for every Claude Code session',
    '- Your context files will be created in step 2 below',
    '',
    'ALMOST THERE — close and reopen Claude Code to activate the plugin.',
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
