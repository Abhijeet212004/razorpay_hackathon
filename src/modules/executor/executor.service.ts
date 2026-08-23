import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { idempotencyKey } from "../../shared/crypto/hash.js";
import { setMerchantContext } from "../../shared/db/merchant-context.js";
import { silentLogger, type Logger } from "../../shared/logger.js";
import { paiseToCanonical } from "../../shared/money.js";
import { append } from "../ledger/ledger.service.js";
import { RailTimeoutError, type PaymentRail } from "../rail/rail.validation.js";
import * as repo from "./executor.repository.js";
import type {
  ExecuteRequest,
  ExecuteResult,
  ExecutorClient,
  OrderState,
  RefundRequest,
  RefundResult,
} from "./executor.validation.js";

/**
 * INV-02: the only component holding a payment credential.
 *
 * It runs after the authorisation transaction has committed, never during: the
 * reservation must be durable before money can move. Reserving then paying can
 * over-count, which is conservative and reaped later; paying then reserving under-counts,
 * which is a cap bypass.
 *
 * The order row is created here rather than in the authorisation transaction, and that
 * ordering is load-bearing: the reaper releases a hold only when no order row exists for
 * its intent, so an order created earlier would make a crashed execution unreapable.
 *
 * Within this function the row is written and committed BEFORE the outbound call. A
 * timeout must not look like a call that never happened: it leaves a payment that may
 * well exist, and reaping the hold would under-count money that moved. The row in
 * SUBMITTING is what says "a call may have been made".
 */

export interface ExecutorDeps {
  readonly pool: Pool;
  readonly rail: PaymentRail;
  readonly logger?: Logger;
}

async function inTransaction<T>(
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

export function createExecutor(deps: ExecutorDeps): ExecutorClient {
  const logger = deps.logger ?? silentLogger;

  async function recordExecution(
    request: ExecuteRequest,
    orderId: string,
    state: OrderState,
    railOrderId: string | null,
    key: string,
  ): Promise<void> {
    try {
      await inTransaction(deps.pool, request.merchantId, async (client) => {
        await repo.setOrderState(
          client,
          orderId,
          state,
          railOrderId === null ? undefined : { railOrderId },
        );
        await append(client, {
          chainId: request.mandateId,
          kind: "API_CALL",
          merchantId: request.merchantId,
          ref: request.intentId,
          payloadRedacted: {
            operation: "orders.create",
            rail: deps.rail.mode,
            idempotency_key: key,
            rail_order_id: railOrderId,
            state,
          },
        });
      });
    } catch (error) {
      // The payment may already have been made. Losing the record of it is bad, but
      // retrying the charge to fix a bookkeeping failure would be worse.
      logger.error("could not record execution outcome", error);
      logger.count("executor.record.failed");
    }
  }

  return {
    async execute(request: ExecuteRequest): Promise<ExecuteResult> {
      const key = idempotencyKey(request.intentId);

      const claimed = await inTransaction(deps.pool, request.merchantId, async (client) => {
        const existing = await repo.findByIntent(client, request.intentId);
        if (existing !== null) return { existing, orderId: existing.orderId };

        const orderId = `ord_${randomUUID()}`;
        // Committed before the call. From here on, the absence of this row means the
        // executor is certain it never reached the rail.
        await repo.insertOrder(client, {
          orderId,
          intentId: request.intentId,
          mandateId: request.mandateId,
          merchantId: request.merchantId,
          amountPaise: request.amountPaise,
          state: "SUBMITTING",
          railOrderId: null,
          railPaymentId: null,
          idempotencyKey: key,
        });
        return { existing: null, orderId };
      });

      if (claimed.existing !== null && claimed.existing.state !== "SUBMITTING") {
        // The same intent already reached the rail and resolved. Returning the existing
        // order is what makes a replayed execution a no-op rather than a second payment.
        return {
          orderId: claimed.existing.orderId,
          state: claimed.existing.state,
          railOrderId: claimed.existing.railOrderId,
          idempotencyKey: claimed.existing.idempotencyKey,
        };
      }

      // A row left in SUBMITTING falls through to the call below on purpose. The
      // idempotency key is sha256(intent_id) and therefore identical, so the rail either
      // returns the order it already has or creates the one it never did. With a
      // deterministic idempotency key, re-issuing the create IS the read — this is not a
      // blind retry and cannot produce a second charge. Do not "fix" it into an early
      // return.

      // Outside any transaction: the rail call must not hold a database lock either.
      let railOrderId: string | null = null;
      let state: OrderState;

      try {
        const railOrder = await deps.rail.createOrder({
          amountPaise: request.amountPaise,
          currency: "INR",
          idempotencyKey: key,
          // The join between the Razorpay dashboard and our ledger: pick any order
          // there, paste the note here, land on the exact rule evaluation.
          notes: {
            intent_id: request.intentId,
            decision_id: request.decisionId,
            amount_paise: paiseToCanonical(request.amountPaise),
          },
        });
        railOrderId = railOrder.railOrderId;
        state = "SUBMITTED";
      } catch (error) {
        // A timeout means we do not know which side of the rail the money is on, so the
        // order becomes AMBIGUOUS and is resolved by reading. A rejection is terminal.
        state = error instanceof RailTimeoutError ? "AMBIGUOUS" : "FAILED";
        logger.error(`rail ${state} for intent ${request.intentId}`, error);
        logger.count(`executor.rail.${state.toLowerCase()}`);
      }

      await recordExecution(request, claimed.orderId, state, railOrderId, key);
      return { orderId: claimed.orderId, state, railOrderId, idempotencyKey: key };
    },

    async refund(request: RefundRequest): Promise<RefundResult> {
      const refundId = `rfd_${randomUUID()}`;
      const key = idempotencyKey(refundId);

      const order = await inTransaction(deps.pool, request.merchantId, async (client) => {
        const found = await repo.findByOrderId(client, request.orderId);
        if (found === null || found.railPaymentId === null) return null;

        await repo.insertRefund(client, {
          refundId,
          orderId: request.orderId,
          merchantId: request.merchantId,
          amountPaise: request.amountPaise,
          reason: request.reason,
          state: "REQUESTED",
          idempotencyKey: key,
        });
        return found;
      });

      if (order === null) return { refundId, state: "FAILED", railRefundId: null };

      let state: RefundResult["state"] = "FAILED";
      let railRefundId: string | null = null;

      try {
        const refund = await deps.rail.createRefund({
          railPaymentId: order.railPaymentId!,
          amountPaise: request.amountPaise,
          idempotencyKey: key,
          notes: { order_id: request.orderId, reason: request.reason },
        });
        railRefundId = refund.railRefundId;
        state = refund.status === "processed" ? "COMPLETED" : "SUBMITTED";
      } catch (error) {
        logger.error(`refund failed for order ${request.orderId}`, error);
        logger.count("executor.refund.failed");
      }

      await inTransaction(deps.pool, request.merchantId, async (client) => {
        await repo.setRefundState(client, refundId, state, railRefundId ?? undefined);
        await append(client, {
          chainId: order.mandateId,
          kind: "REFUND",
          merchantId: request.merchantId,
          ref: order.intentId,
          payloadRedacted: {
            refund_id: refundId,
            order_id: request.orderId,
            amount_paise: paiseToCanonical(request.amountPaise),
            reason: request.reason,
            state,
          },
        });
      });

      return { refundId, state, railRefundId };
    },
  };
}
