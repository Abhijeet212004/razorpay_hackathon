import type { Pool } from "pg";
import { withAuthorizationTransaction } from "../../shared/db/transaction.js";
import { append } from "../ledger/ledger.service.js";
import { releaseReservation } from "../reconciler/reconciler.service.js";
import * as orders from "../executor/executor.repository.js";
import type { PaymentRail } from "../rail/rail.validation.js";
import { JOB_TIMINGS, type JobResult } from "./jobs.validation.js";

/**
 * Resolves orders stuck in SUBMITTED or AMBIGUOUS by reading provider state.
 *
 * It never re-sends a payment. An order that has been ambiguous past the maximum age is
 * marked FAILED_UNRESOLVED and its reservation released with an alert — otherwise an
 * unresolvable order would hold cap forever, which is the failure the reaper cannot
 * cover because an order row exists.
 */
export async function reconcileAmbiguous(
  pool: Pool,
  rail: PaymentRail,
  merchantId: string,
  now: Date = new Date(),
): Promise<JobResult> {
  const options = {
    merchantId,
    lockTimeoutMs: 3_000,
    statementTimeoutMs: 5_000,
    retryAttempts: 3,
    retryBackoffMs: [10, 40, 160],
  };

  const pending = await withAuthorizationTransaction(pool, options, async (client) => {
    const result = await client.query<{
      order_id: string;
      intent_id: string;
      mandate_id: string;
      rzp_order_id: string | null;
      created_at: Date;
    }>(
      `SELECT order_id, intent_id, mandate_id, rzp_order_id, created_at
         FROM orders
        WHERE state IN ('SUBMITTED', 'AMBIGUOUS')
        ORDER BY created_at`,
    );
    return result.rows;
  });

  const details: string[] = [];
  let changed = 0;

  for (const order of pending) {
    const age = now.getTime() - order.created_at.getTime();
    const expired = age > JOB_TIMINGS.reconcileMaxAgeMs;

    let railStatus: string | null = null;
    let railPaymentId: string | null = null;

    if (order.rzp_order_id !== null) {
      try {
        // Reading, never retrying. This is the whole method.
        const railOrder = await rail.fetchOrder(order.rzp_order_id);
        railStatus = railOrder.status;
        railPaymentId = railOrder.railPaymentId;
      } catch {
        railStatus = null;
      }
    }

    const resolved = await withAuthorizationTransaction(pool, options, async (client) => {
      await client.query(`SELECT 1 FROM mandates WHERE mandate_id = $1 FOR UPDATE`, [
        order.mandate_id,
      ]);

      if (railStatus === "paid") {
        await orders.setOrderState(client, order.order_id, "CAPTURED", {
          ...(railPaymentId === null ? {} : { railPaymentId }),
        });
        await client.query(
          `UPDATE reservations SET state = 'captured', resolved_at = now()
            WHERE intent_id = $1 AND state = 'held'`,
          [order.intent_id],
        );
        await append(client, {
          chainId: order.mandate_id,
          kind: "RECONCILE",
          merchantId,
          ref: order.intent_id,
          payloadRedacted: { order_id: order.order_id, resolved_to: "CAPTURED" },
        });
        return "CAPTURED";
      }

      if (railStatus === "failed") {
        await orders.setOrderState(client, order.order_id, "FAILED");
        await releaseReservation(client, order.intent_id, "payment_failed");
        await append(client, {
          chainId: order.mandate_id,
          kind: "RECONCILE",
          merchantId,
          ref: order.intent_id,
          payloadRedacted: { order_id: order.order_id, resolved_to: "FAILED" },
        });
        return "FAILED";
      }

      if (expired) {
        // Giving up is itself a decision, and it is recorded as one. The hold is
        // released so the cap recovers, and an operator is told the truth: we never
        // found out.
        await orders.setOrderState(client, order.order_id, "FAILED_UNRESOLVED");
        await releaseReservation(client, order.intent_id, "unresolved");
        await append(client, {
          chainId: order.mandate_id,
          kind: "RECONCILE",
          merchantId,
          ref: order.intent_id,
          payloadRedacted: {
            order_id: order.order_id,
            resolved_to: "FAILED_UNRESOLVED",
            alert: "operator review required: outcome never established",
          },
        });
        return "FAILED_UNRESOLVED";
      }

      // Still unknown and still inside the window. It stays held, because we do not know
      // whether the money moved and the cap must assume it did.
      return null;
    });

    if (resolved !== null) {
      changed += 1;
      details.push(`${order.order_id}:${resolved}`);
    }
  }

  return { job: "reconcile-ambiguous", examined: pending.length, changed, details };
}
