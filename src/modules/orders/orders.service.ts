import type { Pool, PoolClient } from "pg";
import { setMerchantContext } from "../../shared/db/merchant-context.js";
import { withAuthorizationTransaction } from "../../shared/db/transaction.js";
import { append } from "../ledger/ledger.service.js";
import { releaseReservation } from "../reconciler/reconciler.service.js";
import * as quotes from "../quote/quote.repository.js";
import * as repo from "./orders.repository.js";
import type { CancelOutcome, OrderView } from "./orders.validation.js";

/**
 * What an agent may know and do about orders it placed.
 *
 * Reading is free. Cancelling is not: it releases a hold, which changes the cap sum, so
 * it takes the mandate row lock like any other money-moving action.
 */

export interface OrderOptions {
  readonly merchantId: string;
}

const LOCK = {
  lockTimeoutMs: 3_000,
  statementTimeoutMs: 5_000,
  retryAttempts: 3,
  retryBackoffMs: [10, 40, 160],
} as const;

async function scoped<T>(
  pool: Pool,
  merchantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setMerchantContext(client, merchantId);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function status(
  pool: Pool,
  options: OrderOptions,
  mandateId: string,
  intentId: string,
): Promise<OrderView | null> {
  return scoped(pool, options.merchantId, (client) =>
    repo.byIntent(client, mandateId, intentId),
  );
}

export async function history(
  pool: Pool,
  options: OrderOptions,
  mandateId: string,
  limit = 20,
): Promise<readonly OrderView[]> {
  return scoped(pool, options.merchantId, (client) =>
    repo.history(client, mandateId, limit),
  );
}

/**
 * The line items of a past order, at today's prices.
 *
 * A reorder is not a repeat of a payment — it is a fresh basket, freshly priced, facing
 * every check from scratch. Yesterday's approval buys nothing today: the price may have
 * moved, the item may be withdrawn, the mandate may be spent or revoked.
 */
export async function reorderBasket(
  pool: Pool,
  options: OrderOptions,
  intentId: string,
): Promise<ReadonlyArray<{ sku: string; quantity: number }>> {
  return scoped(pool, options.merchantId, (client) => quotes.basketFor(client, intentId));
}

/**
 * Cancel, which is only honest before the money has moved.
 *
 * After capture there is nothing to cancel — there is a payment to refund, which is a
 * different action with a different permission. And while an order is processing we do
 * not know which side of the rail the money is on, so cancelling would be a guess. The
 * agent is told to wait rather than given a coin flip.
 */
export async function cancel(
  pool: Pool,
  options: OrderOptions,
  mandateId: string,
  intentId: string,
): Promise<CancelOutcome> {
  return withAuthorizationTransaction(
    pool,
    { merchantId: options.merchantId, ...LOCK },
    async (client): Promise<CancelOutcome> => {
      await client.query(`SELECT 1 FROM mandates WHERE mandate_id = $1 FOR UPDATE`, [
        mandateId,
      ]);

      const order = await repo.rawState(client, mandateId, intentId);
      if (order === null) return { kind: "NOT_FOUND" };

      if (order.state === "CAPTURED") {
        return {
          kind: "NOT_PERMITTED",
          reason: "that payment already went through, so it needs a refund rather than a cancellation",
        };
      }

      if (["SUBMITTING", "SUBMITTED", "AMBIGUOUS"].includes(order.state)) {
        return {
          kind: "TOO_LATE",
          reason: "that order is still processing — I do not yet know whether it went through",
        };
      }

      if (order.state !== "AUTHORISED") {
        return { kind: "TOO_LATE", reason: `that order is already ${order.state.toLowerCase()}` };
      }

      await client.query(
        `UPDATE orders SET state = 'FAILED', updated_at = now() WHERE order_id = $1`,
        [order.orderId],
      );
      // Releasing changes the cap sum, which is why this runs under the mandate row lock.
      await releaseReservation(client, intentId, "payment_failed");

      await append(client, {
        chainId: mandateId,
        kind: "RELEASE",
        merchantId: options.merchantId,
        ref: intentId,
        payloadRedacted: { reason: "cancelled_by_agent", order_id: order.orderId },
      });

      return { kind: "CANCELLED", intentId };
    },
  );
}

/** What the mandate has left. An agent that knows this can split an order instead of failing. */
export async function spendRemaining(
  pool: Pool,
  options: OrderOptions,
  mandateId: string,
): Promise<{
  cumulative_paise: string;
  spent_paise: string;
  remaining_paise: string;
  per_transaction_paise: string;
  silent_threshold_paise: string;
  state: string;
} | null> {
  return scoped(pool, options.merchantId, async (client) => {
    const result = await client.query<{
      cumulative_paise: string;
      spent: string;
      per_transaction_paise: string;
      silent_threshold_paise: string;
      state: string;
    }>(
      `SELECT m.cumulative_paise::text,
              m.per_transaction_paise::text,
              m.silent_threshold_paise::text,
              m.state,
              COALESCE((SELECT SUM(amount_paise) FROM reservations r
                         WHERE r.mandate_id = m.mandate_id
                           AND r.state IN ('held','captured')
                           AND r.created_at > now() - m.cumulative_window), 0)::text AS spent
         FROM mandates m WHERE m.mandate_id = $1`,
      [mandateId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;

    const remaining = BigInt(row.cumulative_paise) - BigInt(row.spent);
    return {
      cumulative_paise: row.cumulative_paise,
      spent_paise: row.spent,
      remaining_paise: (remaining > 0n ? remaining : 0n).toString(),
      per_transaction_paise: row.per_transaction_paise,
      silent_threshold_paise: row.silent_threshold_paise,
      state: row.state,
    };
  });
}
