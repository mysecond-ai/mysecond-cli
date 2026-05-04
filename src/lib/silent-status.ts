// Silent status protocol — emit structured JSON events to stdout when
// `mysecond init --silent` is invoked from a Claude Code hook.
//
// Workstream B Phase 2a Day 4. CAIO #5 + brief security DoD #8.
//
// Why JSON: the chat surface in Claude Code Desktop renders cli stdout as
// preformatted text. With prose status messages, the install flow looks
// chaotic ("step 4: Polling /install-ready…", "step 4/13: …"); a JSON
// stream lets the chat client (or downstream tooling) deduplicate, render
// progress, and show actionable errors.
//
// Format: one event per line, each is valid JSON terminated by \n.
//   {"mysecond_status_protocol_version":1,"kind":"<event>","at":"<iso>","..."}
//
// Important per CAIO #5: the version field is named
// `mysecond_status_protocol_version`, NOT `schema_version`. Anthropic's
// hook stdout has reserved fields (`continue`, `stopReason`, `suppressOutput`,
// `systemMessage`); we MUST NOT collide with those, AND we mark our private
// fields with our namespace so a future Anthropic addition can't conflict.
//
// Day-5 stop condition (CTO/CAIO): the cli must NEVER emit non-JSON to
// stdout when --silent is set. Test: assert single-line valid JSON only.

const PROTOCOL_VERSION = 1;

export type StatusKind =
  | 'install_started'
  | 'device_code_minted'
  | 'awaiting_authorization'
  | 'device_authorized'
  | 'install_step_completed'
  | 'install_completed'
  | 'install_failed'
  | 'timeout';

export interface StatusEvent {
  kind: StatusKind;
  /** Free-form properties per event kind. Always JSON-serializable. */
  [key: string]: unknown;
}

let silentMode = false;

/**
 * Set the cli into --silent mode. Call once at startup, before any status
 * emissions. Emissions before this call are no-ops.
 */
export function setSilentMode(enabled: boolean): void {
  silentMode = enabled;
}

export function isSilentMode(): boolean {
  return silentMode;
}

/**
 * Emit a structured status event. No-ops outside --silent mode (so a
 * normal `mysecond init` invocation doesn't pollute stdout with JSON).
 *
 * Errors are swallowed: status emission must never affect the install.
 */
export function emitStatus(event: StatusEvent): void {
  if (!silentMode) return;
  try {
    const payload = {
      mysecond_status_protocol_version: PROTOCOL_VERSION,
      at: new Date().toISOString(),
      ...event,
    };
    // Single line, terminated by exactly one newline. NO trailing whitespace.
    process.stdout.write(JSON.stringify(payload) + '\n');
  } catch {
    // best-effort
  }
}
