import type { Pool } from "pg";
import { withAuthorizationTransaction } from "../../shared/db/transaction.js";
import { append } from "../ledger/ledger.service.js";
import { releaseReservation } from "../reconciler/reconciler.service.js";
import { JOB_TIMINGS, type JobResult } from "./jobs.validation.js";

/**
 * INV-20: every reservation is eventually resolved — captured, released by the
 * reconciler, or reaped when no execution was ever attempted.
 *
 * The reaper. Without it a crashed executor consumes cap until the window rolls.
 *
 * Its rule is deliberately narrow: reap only when the reservation is still held, **no
 * order row exists for its intent**, and it is older than the TTL. That is exactly the
 * case it exists for — a crash between COMMIT and the executor call, where money
 * definitely never moved.
 *
 * A reservation whose order is SUBMITTED or AMBIGUOUS is never reaped. Those belong to
 * the reconciler: we do not know whether the money moved, so the cap must keep assuming
 * it did. Releasing them here would free cap for money that may well have left.
 */
export async function releaseStaleReservations(
  pool: Pool,
  merchantId: string,
  now: Date = new Date(),
): Promise<JobResult> {
  const cutoff = new Date(now.getTime() - JOB_TIMINGS.reservationTtlMs);
  const details: string[] = [];

  const options = {
    merchantId,
    lockTimeoutMs: 3_000,
    statementTimeoutMs: 5_000,
    retryAttempts: 3,
    retryBackoffMs: [10, 40, 160],
  };

  const candidates = await withAuthorizationTransaction(pool, options, async (client) => {
    const result = await client.query<{
      intent_id: string;
      mandate_id: string;
      reservation_id: string;
    }>(
      `SELECT r.intent_id, r.mandate_id, r.reservation_id
         FROM reservations r
    LEFT JOIN orders o ON o.intent_id = r.intent_id
        WHERE r.state = 'held'
          AND r.created_at < $1
          AND o.order_id IS NULL
        ORDER BY r.created_at`,
      [cutoff.toISOString()],
    );
    return result.rows;
  });

  let changed = 0;

  for (const candidate of candidates) {
    // One transaction per reservation, each taking that mandate's row lock: releasing
    // changes the cap sum, so it cannot race an authorisation reading it.
    const released = await withAuthorizationTransaction(pool, options, async (client) => {
      await client.query(`SELECT 1 FROM mandates WHERE mandate_id = $1 FOR UPDATE`, [
        candidate.mandate_id,
      ]);

      // Re-checked under the lock: an executor may have created the order in the moment
      // between the scan and here.
      const order = await client.query(`SELECT 1 FROM orders WHERE intent_id = $1`, [
        candidate.intent_id,
      ]);
      if (order.rowCount !== null && order.rowCount > 0) return false;

      const ok = await releaseReservation(client, candidate.intent_id, "reaped");
      if (!ok) return false;

      await append(client, {
        chainId: candidate.mandate_id,
        kind: "RELEASE",
        merchantId,
        ref: candidate.intent_id,
        payloadRedacted: {
          reservation_id: candidate.reservation_id,
          reason: "reaped",
          note: "no execution was ever attempted",
        },
      });
      return true;
    });

    if (released) {
      changed += 1;
      details.push(candidate.reservation_id);
    }
  }

  return { job: "release-stale-reservations", examined: candidates.length, changed, details };
}
