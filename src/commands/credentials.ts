// `mysecond credentials print [--plaintext]` — the single credential resolver
// that other surfaces (notably the base-plugin SessionStart sync hook) call so
// there is ONE implementation of "where does this project's key live."
//
// Before this existed, the shell hook re-derived credential lookup itself and
// only ever read `.env` — so when the CLI stored the key in the project-scoped
// creds store (or the keychain), the hook silently found nothing and never
// synced. Routing the hook through this command means the hook benefits from
// the CLI's full resolution (keychain → project-scoped file → env, with legacy
// rescue) without duplicating hash/path logic in bash.
//
// `ctx.apiKey` / `ctx.apiBase` are already fully resolved by buildContext, so
// this command is a thin, read-only printer.
//
//   --plaintext  Emit env-style lines for a hook to source/parse:
//                  COMPANION_API_KEY=<token>
//                  COMPANION_API_URL=<url>
//                Default (no flag) masks the token for safe-to-share output.

import type { CommandContext } from '../lib/context.js';

function mask(key: string): string {
  if (key.length <= 12) return key;
  return `${key.slice(0, 12)}…${key.slice(-4)}`;
}

export async function runCredentials(
  args: readonly string[],
  ctx: CommandContext
): Promise<number> {
  const plaintext = args.includes('--plaintext');

  if (ctx.apiKey.length === 0) {
    process.stderr.write(
      'mysecond: no credential found for this project. Run `mysecond init --resume` to reconnect.\n'
    );
    return 1;
  }

  const token = plaintext ? ctx.apiKey : mask(ctx.apiKey);
  process.stdout.write(`COMPANION_API_KEY=${token}\n`);
  process.stdout.write(`COMPANION_API_URL=${ctx.apiBase}\n`);
  return 0;
}
