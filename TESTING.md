# Testing the mySecond CLI

Most behavior is covered by `npm test` (vitest). This doc covers the things that
**automation can't** — behaviors that depend on Claude Code's own runtime (hook
output rendering) and therefore need a real session to confirm.

---

## Verify the plugin-refresh nudge

The "an update to your PM OS is ready — run `plugin-refresh`" notice is printed by
`maybePrintPluginRefreshNudge` (`src/lib/plugin-refresh-nag.ts`) from inside
`mysecond sync`, which runs as the plugin's **SessionStart** hook.

### Why this needs a manual check

A SessionStart hook's **stdout** becomes the model's session-start context (Claude
relays it to the user); its **stderr is silently dropped on exit 0**. Unit/integration
tests assert we write to **stdout** — but only a real Claude Code session confirms
Claude actually surfaces it. (The first version wrote to stderr and was invisible;
nothing but a real session caught that.) So: **run the smoke test below before every
publish to `@latest`, and after any change to the nudge or the sync hook.**

### Smoke test (≈30 seconds, no 24h wait)

`MYSECOND_FORCE_REFRESH_NUDGE=1` emits the nudge **unconditionally** — it skips the
behind-check, the 24h debounce, and the silence flag, and does not mutate any real
state. Use it to see the nudge render on demand.

1. In a project that has the mySecond plugin installed, start Claude Code with the
   env var set, e.g. launch it from a shell where:
   ```bash
   export MYSECOND_FORCE_REFRESH_NUDGE=1
   ```
2. Start a **new session** (SessionStart fires).
3. **Confirm:** Claude's first turn surfaces the update notice (it may paraphrase —
   it's relayed context, not a fixed banner). The literal line `mySecond: an update
   to your PM OS is ready. …` is what Claude sees.
4. Unset the var (`unset MYSECOND_FORCE_REFRESH_NUDGE`) and start another session →
   confirm the nudge is **gone** (i.e. it only fires for real when actually behind).

### Verify the REAL trigger path (optional, more thorough)

To exercise the actual version comparison (not the force bypass):
1. Edit `<project>/.claude/sync-state.json`: set `"installedPluginContractVersion": "0"`
   (a value below the server's current `PLUGIN_CONTRACT_VERSION`).
2. Start a new session → the nudge should appear (server returns a higher
   `latest_plugin_contract_version`).
3. Run the `plugin-refresh` command it suggests, then start a new session → the
   nudge should be **gone** (sync-state now records the current contract version).
4. Start one more session within 24h → still gone (24h debounce + already current).

---

## What the automated tests cover (so you know the gaps)

`npm test` locks the logic and the wiring — these fail in CI if regressed, so you
don't have to remember them:

- `tests/lib/plugin-refresh-nag.test.ts` — the behind/not-behind decision
  (fail-closed on null/malformed versions), the 24h debounce (timestamp-injected,
  no waiting), the silence flag, self-persist, and the `MYSECOND_FORCE_REFRESH_NUDGE`
  affordance.
- `tests/lib/plugin-meta.test.ts` — reading the contract version from an installed
  plugin's `_meta.json` (fail-safe to null on missing/garbage).
- `tests/commands/sync-nudge.test.ts` — **end-to-end** through the real `runSync`:
  that it reports `client_plugin_contract_version` to cli-sync, and that the nudge
  actually lands on **stdout** (not stderr) when the server reports a newer version.
  This is the regression guard for the channel bug.
- `tests/lib/api.test.ts` — `cliSync` sends/omits the `client_plugin_contract_version`
  query param.

**The one thing tests cannot assert** is that Claude Code renders SessionStart-hook
stdout to the user — that's the smoke test above. Do it before publish.

---

## Pre-publish checklist (CLI → `@latest`)

1. `npm test` green + `npm run build` clean.
2. App side deployed first (returns `latest_plugin_contract_version` + embeds it in
   `_meta.json`) — the CLI nudge no-ops against an old app, but the cohort won't be
   nudged until the app is live.
3. **Run the nudge smoke test above in a real Claude Code session.** Confirm Claude
   surfaces it. Do not publish on green unit tests alone.
