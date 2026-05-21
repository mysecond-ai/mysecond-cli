# Track C Status — wsb/c-data-driven-claude-md

**Status:** DONE — all tasks complete, all tests pass, draft PR open.

## Scope completed

All plan requirements for Track C delivered:

- [x] `claudeMdBlock(companyName, pmName, imports)` — accepts optional `imports: readonly string[]`; defaults to `DEFAULT_CLAUDE_MD_IMPORTS` for init back-compat.
- [x] `DEFAULT_CLAUDE_MD_IMPORTS` exported constant — shared between `copy.ts`, `step-7.ts`, and tests.
- [x] `spliceBetweenMarkers(base, start, end, block)` — shared fail-closed helper extracted to `copy.ts`; returns `null` on any marker anomaly (absent, duplicate, reversed, nested).
- [x] `step-7.ts` updated — uses `DEFAULT_CLAUDE_MD_IMPORTS` explicitly + delegates to `spliceBetweenMarkers` for branch (b) (consistent with sync path).
- [x] `regenerateMysecondBlock(claudeMdPath, rootDir, resolvedImports)` in `sync.ts` — re-splices the mysecond block on every sync when server returns `resolved_imports`. Never appends on sync. Fail-closed: leaves file untouched + warns on missing/corrupt markers.
- [x] `sync.ts` wired — calls `regenerateMysecondBlock` after `claudeMdOverride` processing; only fires when `response.resolved_imports` is a non-empty array.
- [x] `api.ts` / `payload.ts` — `resolved_imports?: string[]` added to `CliSyncResponse` type. **CLI does NOT send `member_id`** — contract verified.
- [x] Missing-file warning — after re-splice, warns on stderr for each `resolved_imports` entry that doesn't exist on disk.
- [x] Invited-PM install message — `successBox(…, isInvitedPm=true)` updated from `/prd-generator` → `/personalize-mysecond` (Track D contract).

## Files touched (owned files only)

New files:
- `tests/lib/wsb-track-c.test.ts` — 26 Track C tests
- `tasks/track-c-status.md` (this file)

Modified files:
- `src/lib/copy.ts` — `claudeMdBlock` signature, `DEFAULT_CLAUDE_MD_IMPORTS`, `spliceBetweenMarkers`
- `src/lib/steps/step-7.ts` — uses new exports from `copy.ts`
- `src/commands/sync.ts` — `regenerateMysecondBlock`, wiring, `join` import
- `src/lib/payload.ts` — `resolved_imports?: string[]` on `CliSyncResponse`
- `tests/lib/post-install-message.test.ts` — updated invited-PM test for `/personalize-mysecond`

## Build / lint / test status

- `npm run typecheck`: PASS (tsc --noEmit, zero errors)
- All 30 non-slow test files: PASS (confirmed with `--exclude "**/prune-stale*"`)
- `tests/lib/prune-stale-plugins.test.ts` (24 tests, ~35s): PASS (confirmed in earlier run)
- `tests/lib/wsb-track-c.test.ts` (26 new tests): PASS
- `tests/lib/post-install-message.test.ts` (21 tests): PASS after updating invited-PM test

## Contract assumptions to reconcile with Track B

1. **`resolved_imports` is on-disk paths** (e.g. `context/company.md`, `context/personalization.md`), not DB paths. The CLI prefixes `@` for the `@import` directive. Track B must return these as project-relative paths, not DB-namespaced paths.

2. **Ordering contract**: the plan specifies "company, product, personas, competitors, goals, personalization last." Track B must return them in this order. Track C renders them in the order received.

3. **`resolved_imports` absent = no re-splice**. Older servers or legacy API keys that don't return this field leave the CLAUDE.md block untouched. This is intentional and safe.

4. **Personalization file path on disk**: Track C warns if `context/personalization.md` (or any resolved import) is missing from disk. Track B is assumed to trigger context file download before `resolved_imports` is returned, but if the download and the re-splice happen in the same sync, the warning may fire spuriously on first sync for a new member. This is acceptable noise; on next sync the file will be present.

5. **Name extraction**: `regenerateMysecondBlock` reads company/PM name from the existing block's header line (`# mySecond PM OS — <companyName>` and the `installed for <pmName> at` sentence). If the block was never written (CLAUDE.md without markers) the function no-ops with a warning — which is correct.

## Requests for orchestrator

None — Track C owns no shared files. All wiring is self-contained.

## Blockers

None. Track C is complete pending Track B's server contract being live (resolved_imports in the cli-sync response). Until then, every sync is a graceful no-op on the mysecond block.
