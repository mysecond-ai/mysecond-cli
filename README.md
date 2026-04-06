# @mysecond/cli

Set up your mySecond PM OS in one command.

## Usage

```bash
npx @mysecond/cli join [team-token]
```

Your team admin will share the join token with you. This command:
1. Creates your PM OS directory (`~/[team]-pm-os/`)
2. Downloads your team's context files
3. Installs the mySecond plugin for Claude Code
4. Sets up background sync

## After setup

```bash
cd ~/[team]-pm-os
claude
```

You're ready to go. Run any PM skill by name or just describe what you need.
