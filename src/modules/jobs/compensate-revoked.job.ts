import type { Pool } from "pg";
import { withAuthorizationTransaction } from "../../shared/db/transaction.js";
import { append } from "../ledger/ledger.service.js";
import type { ExecutorClient } from "../executor/executor.validation.js";
import type { JobResult } from "./jobs.validation.js";

/**
 * A payment that landed after the user revoked.
 *
 * The revocation window is covered, not eliminated: an in-flight payment completes and is
 * then refunded as a compensating entry. The system never claims to have stopped
 * something it could not stop.
 *
 * The worker holds no payment credential, so the refund goes through the executor
 * service, which is the only process that does.
 */
export async function compensateRevoked(
  pool: Pool,
  executor: ExecutorClient,
  merchantId: string,
): Promise<JobResult> {
  const options = {
    merchantId,
    lockTimeoutMs: 3_000,
    statementTimeoutMs: 5_000,
    retryAttempts: 3,
    retryBackoffMs: [10, 40, 160],
  };

  const orphaned = await withAuthorizationTransaction(pool, options, async (client) => {
    const result = await client.query<{
      order_id: string;
      intent_id: string;
      mandate_id: string;
      amount_paise: string;
    }>(
      `SELECT o.order_id, o.intent_id, o.mandate_id, o.amount_paise::text
         FROM orders o
         JOIN mandates m ON m.mandate_id = o.mandate_id
    LEFT JOIN refunds r ON r.order_id = o.order_id
        WHERE m.state = 'revoked'
          AND o.state = 'CAPTURED'
          AND m.revoked_at IS NOT NULL
          AND r.refund_id IS NULL`,
    );
    return result.rows;
  });

  const details: string[] = [];

  for (const order of orphaned) {
    const result = await executor.refund({
      orderId: order.order_id,
      merchantId,
      amountPaise: BigInt(order.amount_paise),
      reason: "mandate revoked after capture",
    });

    await withAuthorizationTransaction(pool, options, async (client) => {
      await client.query(`SELECT 1 FROM mandates WHERE mandate_id = $1 FOR UPDATE`, [
        order.mandate_id,
      ]);
      // A refund moves the reservation out of the counted states, which changes the cap
      // sum, so it happens under the mandate row lock.
      await client.query(
        `UPDATE reservations
            SET state = 'released', resolved_at = now(), release_reason = 'refunded'
          WHERE intent_id = $1 AND state IN ('held', 'captured')`,
        [order.intent_id],
      );
      await append(client, {
        chainId: order.mandate_id,
        kind: "RECONCILE",
        merchantId,
        ref: order.intent_id,
        payloadRedacted: {
          order_id: order.order_id,
          compensated_by: result.refundId,
          refund_state: result.state,
        },
      });
    });

    details.push(`${order.order_id}:${result.state}`);
  }

  return {
    job: "compensate-revoked",
    examined: orphaned.length,
    changed: details.length,
    details,
  };
}
