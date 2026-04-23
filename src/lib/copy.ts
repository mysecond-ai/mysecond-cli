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
  ].join('\n');
}

export const CLAUDE_MD_MARKER_START = '<!-- mysecond-start -->';
export const CLAUDE_MD_MARKER_END = '<!-- mysecond-end -->';

// §6.8 framed success box (Ron-B1 v2 + v1.4 restart instruction).
// 51 chars wide, 15 lines tall. {pm_name}+{company_name} truncated to 18 chars
// each (CXO-11) so combined "for X at Y" fits within box width.
const BOX_WIDTH = 51;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function padBoxLine(content: string): string {
  // Box interior is BOX_WIDTH - 2 (for │ on each side). Content padded to fill.
  const interior = BOX_WIDTH - 2;
  const trimmed = content.length > interior ? content.slice(0, interior) : content;
  return `│${trimmed.padEnd(interior, ' ')}│`;
}

export function successBox(pmName: string, companyName: string): string {
  const pm = truncate(pmName, 18);
  const company = truncate(companyName, 18);
  const top = '┌' + '─'.repeat(BOX_WIDTH - 2) + '┐';
  const bottom = '└' + '─'.repeat(BOX_WIDTH - 2) + '┘';
  // RED-TEAM R2 P0-C: skills are namespaced by plugin name in Claude Code
  // (`/<plugin-name>:<skill>`). If the customer has any other marketplace
  // shipping a `pm-os` plugin OR their own project-level `prd-generator`
  // skill, bare `/prd-generator` collides and routes elsewhere. Prefix with
  // `/pm-os:` so the success box advertises the canonical namespaced form.
  const lines = [
    top,
    padBoxLine('  mySecond PM OS installed                       '),
    padBoxLine(`  for ${pm} at ${company}`),
    padBoxLine('                                                 '),
    padBoxLine('  Almost there — close and reopen Claude Code    '),
    padBoxLine('  to activate your PM OS. Your context, skills,  '),
    padBoxLine('  and sync hooks will load automatically on the  '),
    padBoxLine('  next session start.                            '),
    padBoxLine('                                                 '),
    padBoxLine('  After reopening, try:                          '),
    padBoxLine('   /pm-os:prd-generator  (draft a PRD)           '),
    padBoxLine('   /pm-os:skills (see everything available)      '),
    padBoxLine('   /pm-os:enhance-context (upload research,      '),
    padBoxLine('                    interview notes, strategy)   '),
    padBoxLine('  Or just start chatting — your PM context will  '),
    padBoxLine('  be in the conversation.                        '),
    padBoxLine('                                                 '),
    padBoxLine('  ──                                             '),
    padBoxLine('  Syncs automatically on every session.          '),
    bottom,
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
