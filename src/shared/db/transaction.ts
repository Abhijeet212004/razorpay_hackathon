import type { Pool, PoolClient } from "pg";
import { setMerchantContext } from "./merchant-context.js";

/**
 * The authorisation transaction.
 *
 * READ COMMITTED is deliberate. The explicit row lock on the mandate serialises every
 * authoriser for that mandate, and every read that matters happens after the lock is
 * held, so each statement sees committed data. SERIALIZABLE would add predicate locking
 * this path does not use and would turn heavy concurrency on one mandate into a storm of
 * serialization failures.
 *
 * Retries cover contention only: a deadlock, or a lock wait that exceeded lock_timeout.
 * A failed policy check is not an error and never reaches here.
 */

/** Deadlock detected. */
const DEADLOCK_DETECTED = "40P01";
/** Lock not available within lock_timeout. */
const LOCK_NOT_AVAILABLE = "55P03";

const RETRYABLE = new Set([DEADLOCK_DETECTED, LOCK_NOT_AVAILABLE]);

export class LockContentionError extends Error {
  constructor(readonly attempts: number, readonly lastSqlstate: string) {
    super(`authorisation could not acquire the mandate row lock in ${attempts} attempts`);
    this.name = "LockContentionError";
  }
}

export interface TransactionOptions {
  readonly merchantId: string;
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly retryAttempts: number;
  readonly retryBackoffMs: readonly number[];
}

function sqlstateOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/** Backoff with plus or minus 50% jitter, so retries do not re-collide in lockstep. */
function jitter(base: number): number {
  return Math.round(base * (0.5 + Math.random()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn` inside a READ COMMITTED transaction with timeouts and the merchant context
 * applied, retrying only on lock contention. Throws LockContentionError when the retry
 * budget is exhausted, which the caller reports as SYS-003 — distinct from a dependency
 * being unavailable, because contention and outage are different operational signals.
 */
export async function withAuthorizationTransaction<T>(
  pool: Pool,
  options: TransactionOptions,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  let lastSqlstate = "";

  for (let attempt = 0; attempt < options.retryAttempts; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query(`SET LOCAL lock_timeout = ${Number(options.lockTimeoutMs)}`);
      await client.query(`SET LOCAL statement_timeout = ${Number(options.statementTimeoutMs)}`);
      await setMerchantContext(client, options.merchantId);

      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);

      const code = sqlstateOf(error);
      if (code === undefined || !RETRYABLE.has(code)) throw error;

      lastSqlstate = code;
      const backoff = options.retryBackoffMs[attempt];
      if (backoff !== undefined) await sleep(jitter(backoff));
    } finally {
      client.release();
    }
  }

  throw new LockContentionError(options.retryAttempts, lastSqlstate);
}
