# @mysecond/cli

The CLI installer + sync agent for [mySecond](https://mysecond.ai), the PM Operating System for product teams.

## Install

```bash
npm install -g @mysecond/cli
mysecond init --api-key <your-api-key>
```

Your API key comes from `mysecond.ai/activate/complete` after you finish the context wizard.

## Subcommands

| Command | Purpose |
|---|---|
| `mysecond init` | Install the PM OS into the current Claude Code workspace. Idempotent and resumable. |
| `mysecond sync` | Pull the latest context, skills, and agents from mysecond.ai into the workspace. |
| `mysecond artifact-sync` | Push a changed artifact (skill output, doc, plan) up to mysecond.ai. |

## Status

This is the v1.1.0 scaffold. `init`, `sync`, and `artifact-sync` are stubs that exit with a "not yet implemented" message. Real implementations land in:

- **PR 4b** — `sync` and `artifact-sync` (port from `mysecond-app/scripts/sync-context.js`)
- **PR 4c** — `init` (13 atomic, idempotent, resumable steps per [EDD §6](https://github.com/yangro/pmkit.ai/blob/main/specs/EDD-solo-phase-4-pmkit-cli.md))

## Requirements

- Node.js 18 or newer
- An active mySecond subscription ([mysecond.ai/pricing](https://mysecond.ai/pricing))
- Claude Code (Desktop or CLI)

## Environment variables

| Variable | Effect |
|---|---|
| `COMPANION_API_KEY` | Override the device token (legacy / per-shell auth path). |
| `COMPANION_API_URL` | Override the API host (staging / local dev). |
| `MYSECOND_NO_KEYCHAIN=1` | Force file-fallback credential storage even on macOS. |
| `MYSECOND_NO_UPGRADE_NAG=1` | Silence the once-per-day "your CLI is behind" stderr line on session-start sync. |

## Development

```bash
npm install
npm run typecheck    # tsc --noEmit
npm run build        # esbuild bundle → dist/mysecond.mjs
npm test             # vitest run
node bin/mysecond.cjs --help
```

## Releasing

Tag a version and push the tag — CI publishes to npm automatically.

```bash
npm version patch    # or minor/major
git push --follow-tags
```

## License

UNLICENSED — proprietary. © mySecond.
