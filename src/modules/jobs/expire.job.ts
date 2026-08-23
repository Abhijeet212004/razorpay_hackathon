import type { Pool } from "pg";
import { withAuthorizationTransaction } from "../../shared/db/transaction.js";
import { append } from "../ledger/ledger.service.js";
import { releaseReservation } from "../reconciler/reconciler.service.js";
import type { JobResult } from "./jobs.validation.js";

const OPTIONS = {
  lockTimeoutMs: 3_000,
  statementTimeoutMs: 5_000,
  retryAttempts: 3,
  retryBackoffMs: [10, 40, 160],
} as const;

/** Sweeps mandates past not_after, so the policy check stays a lookup rather than a date sum. */
export async function expireMandates(
  pool: Pool,
  merchantId: string,
  now: Date = new Date(),
): Promise<JobResult> {
  return withAuthorizationTransaction(pool, { merchantId, ...OPTIONS }, async (client) => {
    const result = await client.query<{ mandate_id: string }>(
      `UPDATE mandates SET state = 'expired'
        WHERE state = 'live' AND not_after <= $1
        RETURNING mandate_id`,
      [now.toISOString()],
    );
    return {
      job: "expire-mandates",
      examined: result.rows.length,
      changed: result.rows.length,
      details: result.rows.map((r) => r.mandate_id),
    };
  });
}

/**
 * A step-up nobody approved. The reservation written at STEP_UP is released, because that
 * hold was only ever a placeholder for a purchase awaiting a human.
 */
export async function expireChallenges(
  pool: Pool,
  merchantId: string,
  now: Date = new Date(),
): Promise<JobResult> {
  const options = { merchantId, ...OPTIONS };

  const stale = await withAuthorizationTransaction(pool, options, async (client) => {
    const result = await client.query<{
      challenge_id: string;
      intent_id: string;
      mandate_id: string;
    }>(
      `SELECT challenge_id, intent_id, mandate_id FROM challenges
        WHERE state = 'pending' AND expires_at <= $1`,
      [now.toISOString()],
    );
    return result.rows;
  });

  let changed = 0;

  for (const challenge of stale) {
    await withAuthorizationTransaction(pool, options, async (client) => {
      await client.query(`SELECT 1 FROM mandates WHERE mandate_id = $1 FOR UPDATE`, [
        challenge.mandate_id,
      ]);
      await client.query(
        `UPDATE challenges SET state = 'expired', resolved_at = now() WHERE challenge_id = $1`,
        [challenge.challenge_id],
      );
      await releaseReservation(client, challenge.intent_id, "step_up_abandoned");
      await append(client, {
        chainId: challenge.mandate_id,
        kind: "RELEASE",
        merchantId,
        ref: challenge.intent_id,
        payloadRedacted: { reason: "step_up_abandoned", challenge_id: challenge.challenge_id },
      });
    });
    changed += 1;
  }

  return {
    job: "expire-challenges",
    examined: stale.length,
    changed,
    details: stale.map((c) => c.challenge_id),
  };
}
