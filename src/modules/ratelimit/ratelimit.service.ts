import type { Pool } from "pg";
import { setMerchantContext } from "../../shared/db/merchant-context.js";

/**
 * LMT-005 — the request rate limit, at the edge.
 *
 * A token bucket in Postgres rather than in memory, so it survives more than one kernel
 * instance. An in-memory limiter on three replicas is a limit three times looser than it
 * says it is, which is worse than none because it reads as a control.
 *
 * This is deliberately NOT the spend velocity check. LMT-003 counts money inside the
 * mandate row lock; this counts requests before any lock is taken. Conflating them was
 * a real confusion earlier in the design: one protects the merchant's cap, the other
 * protects the merchant's server.
 *
 * The refill is computed from elapsed time rather than run on a timer, so there is
 * nothing to schedule and a bucket that is never touched costs nothing.
 */

export interface Bucket {
  /** Requests allowed in a full bucket. */
  readonly capacity: number;
  /** Tokens added per second. */
  readonly refillPerSecond: number;
}

/**
 * Deliberately different per action, because the cost of abusing them differs.
 *
 * `consent` is the tightest by a long way: it sends a one-time code to a phone number the
 * caller supplies, which on a public endpoint is an SMS-bombing primitive if left open.
 */
export const BUCKETS: Readonly<Record<string, Bucket>> = {
  // Per agent, per the documented figure.
  agent: { capacity: 30, refillPerSecond: 0.5 },
  // Per mandate, tighter — this is the one that fronts money.
  mandate: { capacity: 10, refillPerSecond: 10 / 60 },
  // Session creation. Cheap for us, but each one writes an agent row.
  session: { capacity: 10, refillPerSecond: 1 / 60 },
  // Sends an SMS to a number the caller chose. Three an hour, per source.
  consent: { capacity: 3, refillPerSecond: 3 / 3600 },
  // Pricing runs a real query against the merchant's catalog.
  quote: { capacity: 60, refillPerSecond: 1 },
};

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Seconds until one more token is available. Sent as Retry-After. */
  readonly retryAfter: number;
}

/**
 * Consumes one token.
 *
 * Atomic: the bucket row is locked for the duration, so two concurrent requests cannot
 * both see the last token.
 *
 * The refill clock is only advanced by however much was actually credited. Advancing it
 * on a rejected request would discard the time that accrued while the caller was being
 * refused — a client that kept retrying would never recover, which turns a rate limit
 * into a permanent lockout the caller inflicts on themselves.
 */
export async function consume(
  pool: Pool,
  merchantId: string,
  kind: keyof typeof BUCKETS | string,
  subject: string,
): Promise<RateLimitResult> {
  const bucket = BUCKETS[kind] ?? BUCKETS.agent!;
  const key = `${kind}:${subject}`;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setMerchantContext(client, merchantId);

    // A new bucket starts full, minus the token this request takes.
    await client.query(
      `INSERT INTO rate_limit_buckets (bucket_key, merchant_id, tokens, refilled_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (bucket_key) DO NOTHING`,
      [key, merchantId, bucket.capacity],
    );

    const locked = await client.query<{ available: string }>(
      `SELECT LEAST(
                tokens + EXTRACT(EPOCH FROM (now() - refilled_at)) * $2,
                $3
              )::text AS available
         FROM rate_limit_buckets
        WHERE bucket_key = $1
        FOR UPDATE`,
      [key, bucket.refillPerSecond, bucket.capacity],
    );

    const available = Number(locked.rows[0]?.available ?? 0);
    const allowed = available >= 1;

    if (allowed) {
      await client.query(
        `UPDATE rate_limit_buckets SET tokens = $2, refilled_at = now() WHERE bucket_key = $1`,
        [key, available - 1],
      );
    } else {
      // Credit what accrued, but leave the clock where the caller can still earn from it.
      await client.query(
        `UPDATE rate_limit_buckets SET tokens = $2, refilled_at = now() WHERE bucket_key = $1`,
        [key, available],
      );
    }

    await client.query("COMMIT");

    return {
      allowed,
      remaining: Math.max(0, Math.floor(allowed ? available - 1 : available)),
      retryAfter: allowed ? 0 : Math.max(1, Math.ceil((1 - available) / bucket.refillPerSecond)),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    // Fail closed. A limiter that opens when its own storage is unavailable is not a
    // limiter, and this is the one control whose failure an attacker can trigger.
    throw error;
  } finally {
    client.release();
  }
}

/**
 * What identifies the caller when there is no agent yet.
 *
 * A forwarded address is attacker-controlled unless a proxy you trust set it, so only the
 * left-most entry is used and only when the deployment says to trust it.
 */
export function callerKey(
  headers: Record<string, string | string[] | undefined>,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const forwarded = headers["x-forwarded-for"];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = value?.split(",")[0]?.trim();
    if (first !== undefined && first.length > 0) return first;
  }
  return "unattributed";
}
