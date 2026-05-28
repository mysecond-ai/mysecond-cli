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
  // Never fully disclose, even for short test/dev tokens.
  if (key.length <= 8) return '•'.repeat(key.length);
  return `${key.slice(0, Math.min(12, key.length - 4))}…${key.slice(-4)}`;
}

/**
 * POSIX single-quote escaping. `--plaintext` output is designed for a hook to
 * `source`/`eval`, so values MUST be quoted — a token/URL containing shell
 * metacharacters (`$(...)`, backticks, spaces, newlines) would otherwise
 * execute or corrupt the sourced environment. Single quotes suppress ALL
 * expansion; the only escape needed is the single quote itself.
 */
function shQuote(v: string): string {
  return `'${v.replace(/'/g, "'\\''")}'`;
}

export async function runCredentials(
  args: readonly string[],
  ctx: CommandContext
): Promise<number> {
  // Require the explicit `print` action when an action is given, so a typo'd
  // subcommand (`mysecond credentials dump --plaintext`) can't accidentally
  // dump the raw credential. Bare `mysecond credentials` (no action) stays
  // valid and prints masked.
  const action = args.find((a) => !a.startsWith('-'));
  if (action !== undefined && action !== 'print') {
    process.stderr.write(
      `mysecond: unknown action '${action}'. Usage: mysecond credentials print [--plaintext]\n`
    );
    return 2;
  }

  const plaintext = args.includes('--plaintext');

  if (ctx.apiKey.length === 0) {
    process.stderr.write(
      'mysecond: no credential found for this project. Run `mysecond init --resume` to reconnect.\n'
    );
    return 1;
  }

  if (plaintext) {
    // Quoted — safe to `source`/`eval`.
    process.stdout.write(`COMPANION_API_KEY=${shQuote(ctx.apiKey)}\n`);
    process.stdout.write(`COMPANION_API_URL=${shQuote(ctx.apiBase)}\n`);
    return 0;
  }

  // Masked, human-readable (display only — never sourced).
  process.stdout.write(`COMPANION_API_KEY=${mask(ctx.apiKey)}\n`);
  process.stdout.write(`COMPANION_API_URL=${ctx.apiBase}\n`);
  return 0;
}
