# mysecond-cli

The customer-visible CLI binary for mySecond — published to npm as `@mysecond/cli`, run by customers as `mysecond init` / `mysecond sync` / `mysecond artifact-sync` inside Claude Code.

## What this repo is

- Standalone TypeScript + esbuild scaffold for the `mysecond` binary
- Published to npm as `@mysecond/cli` (public scope)
- Companion to the `mysecond-app` server (Next.js / Vercel) and `product-manager-os` plugin
- Internal codename in branches/specs: `pmkit` / phase-4 (per Decision 0-A in EDD)

## Spec ownership

Authoritative specs live in PMKit (the strategic repo), NOT here:
- Engineering Design Doc: `~/Documents/PMKit/specs/EDD-solo-phase-4-pmkit-cli.md`
- Product Requirements: `~/Documents/PMKit/specs/PRD-solo-install-path.md`
- System Spec: `~/Documents/PMKit/specs/SPEC-solo-install-path.md`
- Implementation Plan: `~/Documents/PMKit/specs/PLAN-solo-install-path.md`

## Build commands

```bash
npm install
npm run typecheck    # tsc --noEmit
npm run build        # esbuild → dist/mysecond.mjs
npm test             # vitest run
```

## Architecture notes

- **Entry shim** is `bin/mysecond.cjs` (CommonJS) — runs Node version guard before parsing the ESM bundle. Customers on pre-Node-18 get a clear error instead of a cryptic SyntaxError.
- **ESM bundle** at `dist/mysecond.mjs` — built by esbuild, bundles everything except `@sentry/node` (Sentry pulls in optional native modules incompatible with esbuild).
- **No CommonJS in `src/`** — `package.json` declares `"type": "module"`; only `bin/mysecond.cjs` opts back into CJS via the explicit `.cjs` extension.

## Release process

Tag pushes trigger CI publish. NPM_TOKEN lives in repo secrets (90-day rotation 2026-07-21; migrate to npm Trusted Publishing OIDC after first publish).

```bash
npm version patch    # or minor/major
git push --follow-tags
```

## Co-existence with PMKit conventions

This repo is a sibling product to `mysecond-app` and `pmkit.ai`. Strategic decisions, persona definitions, and cross-repo conventions live in `~/Documents/PMKit/CLAUDE.md` — read that for company/product context when working here.

<!-- MEMORY:START -->
# mysecond-cli

_Last updated: 2026-04-06 | 0 active memories, 0 total_

_For deeper context, use memory_search, memory_related, or memory_ask tools._
<!-- MEMORY:END -->
