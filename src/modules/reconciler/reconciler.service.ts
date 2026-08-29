import { createHmac, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { setMerchantContext } from "../../shared/db/merchant-context.js";
import { silentLogger, type Logger } from "../../shared/logger.js";
import { withAuthorizationTransaction } from "../../shared/db/transaction.js";
import { append } from "../ledger/ledger.service.js";
import * as orders from "../executor/executor.repository.js";
import type { PaymentRail } from "../rail/rail.validation.js";
import * as repo from "./reconciler.repository.js";
import {
  WebhookEnvelopeSchema,
  type IngestOutcome,
} from "./reconciler.validation.js";

/**
 * Three controls, because a signature proves only one of the three things that matter.
 *
 *   1. HMAC verification proves the event came from the rail.
 *   2. The uniqueness of provider_event_id proves it is applied at most once.
 *   3. orders.fetch proves what actually happened — the payload alone is never trusted.
 *
 * INV-07: there is deliberately no path from AMBIGUOUS back to SUBMITTED. An ambiguous outcome is
 * resolved by reading provider state, never by re-sending the payment. The missing arrow
 * is the double charge that never happens.
 */

export interface ReconcilerDeps {
  readonly pool: Pool;
  readonly rail: PaymentRail;
  readonly webhookSecret: string;
  readonly merchantId: string;
  readonly logger?: Logger;
  /**
   * Called once a payment is confirmed captured, so the merchant's own system records the
   * order. It runs after the transition commits: a merchant that cannot be reached must
   * not roll back a payment that already happened.
   */
  readonly onCaptured?: (intentId: string) => Promise<void>;
}

const TRANSITION_OPTIONS = {
  lockTimeoutMs: 3_000,
  statementTimeoutMs: 5_000,
  retryAttempts: 3,
  retryBackoffMs: [10, 40, 160],
} as const;

/** Constant-time, so a signature cannot be guessed byte by byte from response timing. */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  provided: string,
): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(provided, "hex");
  } catch {
    return false;
  }
  if (supplied.length !== expected.length) return false;
  return timingSafeEqual(expected, supplied);
}

export async function ingestWebhook(
  deps: ReconcilerDeps,
  rawBody: string,
  signature: string | undefined,
): Promise<IngestOutcome> {
  const logger = deps.logger ?? silentLogger;

  if (signature === undefined || !verifyWebhookSignature(deps.webhookSecret, rawBody, signature)) {
    logger.count("reconciler.webhook.unverified");
    return { kind: "UNVERIFIED" };
  }

  const parsed = WebhookEnvelopeSchema.safeParse(JSON.parse(rawBody));
  if (!parsed.success) return { kind: "MALFORMED" };

  const envelope = parsed.data;
  const payment = envelope.payload.payment?.entity;
  if (payment === undefined) return { kind: "MALFORMED" };

  const outcome = await withAuthorizationTransaction(
    deps.pool,
    { merchantId: deps.merchantId, ...TRANSITION_OPTIONS },
    async (client) => applyEvent(deps, client, envelope.id, envelope.event, payment),
  );

  // After the transition has committed, and outside every lock.
  if (outcome.kind === "APPLIED" && outcome.state === "CAPTURED" && deps.onCaptured) {
    const { intentId } = outcome;
    await deps.onCaptured(intentId).catch((error: unknown) => {
      logger.error(`fulfilment hook failed for ${intentId}`, error);
    });
  }

  return outcome;
}

async function applyEvent(
  deps: ReconcilerDeps,
  client: PoolClient,
  providerEventId: string,
  eventType: string,
  payment: { id: string; order_id: string; status: string },
): Promise<IngestOutcome> {
  const claimed = await repo.claimEvent(client, {
    providerEventId,
    merchantId: deps.merchantId,
    eventType,
    payload: { payment_id: payment.id, order_id: payment.order_id, status: payment.status },
  });

  if (!claimed) return { kind: "DUPLICATE", providerEventId };

  const order = await repo.findOrderByRailId(client, payment.order_id);
  if (order === null) return { kind: "UNKNOWN_ORDER", railOrderId: payment.order_id };

  // Read current truth from the rail rather than trusting the payload. The signature
  // proved who sent the event; it did not prove the event is still accurate.
  const railOrder = await deps.rail.fetchOrder(payment.order_id);

  const captured = railOrder.status === "paid" && railOrder.amountPaidPaise > 0n;
  const state = captured ? "CAPTURED" : "FAILED";

  await orders.setOrderState(client, order.orderId, state, {
    railPaymentId: railOrder.railPaymentId ?? payment.id,
  });


  if (captured) {
    await repo.captureReservation(client, order.intentId);
  } else {
    await releaseReservation(client, order.intentId, "payment_failed");
  }

  await append(client, {
    chainId: order.mandateId,
    kind: "WEBHOOK",
    merchantId: deps.merchantId,
    ref: order.intentId,
    payloadRedacted: {
      provider_event_id: providerEventId,
      event: eventType,
      rail_order_id: payment.order_id,
      confirmed_by: "orders.fetch",
    },
  });

  await append(client, {
    chainId: order.mandateId,
    kind: captured ? "EXECUTION_RESULT" : "RELEASE",
    merchantId: deps.merchantId,
    ref: order.intentId,
    payloadRedacted: {
      order_id: order.orderId,
      state,
      rail_status: railOrder.status,
    },
  });

  // The intent id travels in the outcome rather than a module-level variable: two
  // webhooks arriving together must not read each other's.
  return { kind: "APPLIED", orderId: order.orderId, intentId: order.intentId, state };
}

/**
 * Moving a reservation out of ('held','captured') changes the cap sum, so it happens
 * inside a transaction that holds the mandate row lock. This helper is called from
 * within one.
 */
export async function releaseReservation(
  client: PoolClient,
  intentId: string,
  reason: "payment_failed" | "reaped" | "step_up_abandoned" | "unresolved" | "refunded",
): Promise<boolean> {
  const result = await client.query(
    `UPDATE reservations
        SET state = 'released', resolved_at = now(), release_reason = $2
      WHERE intent_id = $1 AND state IN ('held', 'captured')`,
    [intentId, reason],
  );
  return result.rowCount === 1;
}
