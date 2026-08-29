import type { PoolClient } from "pg";
import type { Paise } from "../../shared/money.js";
import type { OrderState } from "./executor.validation.js";

export interface OrderRow {
  orderId: string;
  intentId: string;
  mandateId: string;
  merchantId: string;
  amountPaise: Paise;
  state: OrderState;
  railOrderId: string | null;
  railPaymentId: string | null;
  idempotencyKey: string;
}

export async function insertOrder(client: PoolClient, order: OrderRow): Promise<void> {
  await client.query(
    `INSERT INTO orders (
       order_id, intent_id, mandate_id, merchant_id, amount_paise, state, idempotency_key
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      order.orderId,
      order.intentId,
      order.mandateId,
      order.merchantId,
      order.amountPaise.toString(),
      order.state,
      order.idempotencyKey,
    ],
  );
}

export async function findByIntent(
  client: PoolClient,
  intentId: string,
): Promise<OrderRow | null> {
  const result = await client.query<{
    order_id: string;
    intent_id: string;
    mandate_id: string;
    merchant_id: string;
    amount_paise: string;
    state: OrderState;
    rzp_order_id: string | null;
    rzp_payment_id: string | null;
    idempotency_key: string;
  }>(
    `SELECT order_id, intent_id, mandate_id, merchant_id, amount_paise::text,
            state, rzp_order_id, rzp_payment_id, idempotency_key
       FROM orders WHERE intent_id = $1`,
    [intentId],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        orderId: row.order_id,
        intentId: row.intent_id,
        mandateId: row.mandate_id,
        merchantId: row.merchant_id,
        amountPaise: BigInt(row.amount_paise),
        state: row.state,
        railOrderId: row.rzp_order_id,
        railPaymentId: row.rzp_payment_id,
        idempotencyKey: row.idempotency_key,
      };
}

export async function findByOrderId(
  client: PoolClient,
  orderId: string,
): Promise<OrderRow | null> {
  const result = await client.query<{ intent_id: string }>(
    `SELECT intent_id FROM orders WHERE order_id = $1`,
    [orderId],
  );
  const row = result.rows[0];
  return row === undefined ? null : findByIntent(client, row.intent_id);
}

export async function setOrderState(
  client: PoolClient,
  orderId: string,
  state: OrderState,
  rail?: { railOrderId?: string; railPaymentId?: string },
): Promise<void> {
  await client.query(
    `UPDATE orders
        SET state = $2,
            rzp_order_id = COALESCE($3, rzp_order_id),
            rzp_payment_id = COALESCE($4, rzp_payment_id),
            updated_at = now()
      WHERE order_id = $1`,
    [orderId, state, rail?.railOrderId ?? null, rail?.railPaymentId ?? null],
  );
}

export interface RefundRow {
  refundId: string;
  orderId: string;
  merchantId: string;
  amountPaise: Paise;
  reason: string;
  state: "REQUESTED" | "SUBMITTED" | "COMPLETED" | "FAILED";
  idempotencyKey: string;
}

export async function insertRefund(client: PoolClient, refund: RefundRow): Promise<void> {
  await client.query(
    `INSERT INTO refunds (
       refund_id, order_id, merchant_id, amount_paise, reason, state, idempotency_key
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      refund.refundId,
      refund.orderId,
      refund.merchantId,
      refund.amountPaise.toString(),
      refund.reason,
      refund.state,
      refund.idempotencyKey,
    ],
  );
}

export async function setRefundState(
  client: PoolClient,
  refundId: string,
  state: RefundRow["state"],
  railRefundId?: string,
): Promise<void> {
  await client.query(
    `UPDATE refunds
        SET state = $2, rzp_refund_id = COALESCE($3, rzp_refund_id), updated_at = now()
      WHERE refund_id = $1`,
    [refundId, state, railRefundId ?? null],
  );
}

/** The instrument a mandate may be charged against, if the shopper attached one. */
export async function findPaymentInstrument(
  client: PoolClient,
  mandateId: string,
): Promise<{ customerId: string; tokenId: string } | null> {
  const result = await client.query<{
    payment_customer_ref: string | null;
    payment_token_ref: string | null;
  }>(
    `SELECT payment_customer_ref, payment_token_ref FROM mandates WHERE mandate_id = $1`,
    [mandateId],
  );
  const row = result.rows[0];
  if (row?.payment_customer_ref == null || row.payment_token_ref == null) return null;
  return { customerId: row.payment_customer_ref, tokenId: row.payment_token_ref };
}

/** Records the instrument the shopper authorised. Written once, at consent. */
export async function attachPaymentInstrument(
  client: PoolClient,
  mandateId: string,
  instrument: { customerId: string; tokenId: string; maxAmountPaise: bigint | null },
): Promise<void> {
  await client.query(
    `UPDATE mandates
        SET payment_customer_ref = $2, payment_token_ref = $3, payment_max_paise = $4
      WHERE mandate_id = $1`,
    [mandateId, instrument.customerId, instrument.tokenId, instrument.maxAmountPaise],
  );
}
