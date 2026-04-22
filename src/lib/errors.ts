// MysecondError — typed error class with explicit exit codes per EDD §8.1.
//
// EDD §8.1 defines 13 distinct exit codes (canonical table). Each customer-facing
// failure path throws a MysecondError with the appropriate code; main()'s catch
// translates to process.exit() + actionable stderr message. Avoids the failure mode
// where every unexpected throw collapses to exit 1, which makes ops debugging harder
// and blocks customer-facing copy from referencing specific codes.
//
// Per EDD §0 Decision 0-B + CTO PR 4a forward-work item #2 (TODO marker in
// src/index.ts catch block points here).

export type ExitCode =
  | 0    // success
  | 1    // generic / 1a invalid_key / 1b subscription_cancelled / 1c plugin_revoked (sub-coded via subCode)
  | 2    // local state conflict
  | 3    // 3a schema_drift / 3b network unreachable / 3c Node version too old / 3d Claude Code too old
  | 4    // regen-gap timeout
  | 5    // admin restricted
  | 6    // regen_failed
  | 7    // rollback pause
  | 8    // auth-thrash circuit
  | 130; // SIGINT

export type ExitSubCode =
  | 'invalid_key'
  | 'subscription_cancelled'
  | 'plugin_revoked'
  | 'schema_drift'
  | 'network'
  | 'node_too_old'
  | 'claude_code_too_old';

export class MysecondError extends Error {
  readonly exitCode: ExitCode;
  readonly subCode?: ExitSubCode;

  constructor(exitCode: ExitCode, message: string, options?: { subCode?: ExitSubCode; cause?: unknown }) {
    // Use Error's native `cause` (ES2022) so `instanceof Error` consumers get the
    // original cause chain via err.cause without a parallel field.
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'MysecondError';
    this.exitCode = exitCode;
    this.subCode = options?.subCode;
  }

  // Convenience factories for the most common throw sites. Adding more as PR 4c
  // implements the 13 init steps and triggers each exit code.
  static invalidApiKey(detail?: string): MysecondError {
    return new MysecondError(
      1,
      `Invalid API key. Get a new one at https://mysecond.ai/activate/complete${detail ? ` (${detail})` : ''}.`,
      { subCode: 'invalid_key' }
    );
  }

  static subscriptionCancelled(): MysecondError {
    return new MysecondError(
      1,
      'Your mySecond subscription is inactive. Reactivate at https://mysecond.ai/account.',
      { subCode: 'subscription_cancelled' }
    );
  }

  static pluginRevoked(): MysecondError {
    return new MysecondError(
      1,
      'Your mySecond plugin access has been revoked. Contact support@mysecond.ai.',
      { subCode: 'plugin_revoked' }
    );
  }

  static localStateConflict(detail: string): MysecondError {
    return new MysecondError(2, `Local state conflict: ${detail}. Run with --fix to resolve.`);
  }

  static networkUnreachable(detail?: string): MysecondError {
    return new MysecondError(
      3,
      `Cannot reach mysecond.ai${detail ? ` (${detail})` : ''}. Check your internet connection and try again.`,
      { subCode: 'network' }
    );
  }

  static nodeTooOld(actualVersion: string): MysecondError {
    return new MysecondError(
      3,
      `mysecond requires Node 18 or newer — you're on ${actualVersion}. Upgrade Node (nvm install 18 / brew upgrade node) and re-run.`,
      { subCode: 'node_too_old' }
    );
  }

  static authThrashCircuit(retryCount: number): MysecondError {
    return new MysecondError(
      8,
      `Auth-thrash circuit tripped after ${retryCount} consecutive 401 retries. Contact support@mysecond.ai — your API key may need manual reset.`
    );
  }

  static rollbackPause(): MysecondError {
    return new MysecondError(
      7,
      'mysecond is paused for a brief rollback window. Try again in a few minutes.'
    );
  }
}

// Helper for main() catch — translates any thrown value into an exit code + stderr message.
export function exitFromError(err: unknown): number {
  if (err instanceof MysecondError) {
    process.stderr.write(`mysecond: ${err.message}\n`);
    return err.exitCode;
  }
  // Unexpected throw — surface stack so customer + support can debug.
  process.stderr.write(
    `mysecond: unexpected error: ${err instanceof Error && err.stack ? err.stack : String(err)}\n`
  );
  return 1;
}
