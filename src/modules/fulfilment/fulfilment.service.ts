import type { Pool } from "pg";
import { assertEgressPermitted } from "../../shared/egress-guard.js";
import { setMerchantContext } from "../../shared/db/merchant-context.js";
import { silentLogger, type Logger } from "../../shared/logger.js";

/**
 * Tells the merchant that an agent's purchase happened, so it becomes a real order in
 * their own system — visible in My Orders, in their admin, and in the shopper's inbox.
 *
 * Without this an agent purchase settles in Razorpay and appears nowhere the shopper
 * looks, which is indistinguishable from a bug however correct the ledger is.
 *
 * The merchant resolves customer_ref and fulfilment_ref against their own records. We
 * send two opaque ids and never an address: there is nothing here to leak, and nothing
 * extra to erase.
 */

export interface FulfilmentOptions {
  readonly merchantId: string;
  readonly fulfilUrl: string;
  readonly token: string;
  readonly publicBaseUrl: string;
  readonly timeoutMs?: number;
  readonly logger?: Logger;
}

export async function fulfil(
  pool: Pool,
  options: FulfilmentOptions,
  intentId: string,
): Promise<{ ok: boolean; detail?: string | undefined }> {
  const logger = options.logger ?? silentLogger;

  const client = await pool.connect();
  let payload: {
    customerRef: string | null;
    fulfilmentRef: string | null;
    amountPaise: string;
    items: Array<{ sku: string; quantity: number }>;
    paymentId: string | null;
  };

  try {
    await client.query("BEGIN");
    await setMerchantContext(client, options.merchantId);
    const result = await client.query<{
      customer_ref: string | null;
      fulfilment_ref: string | null;
      amount_paise: string;
      basket: Array<{ sku: string; quantity: number }>;
      rzp_payment_id: string | null;
    }>(
      `SELECT m.customer_ref, m.fulfilment_ref, o.amount_paise::text,
              COALESCE(q.basket, '[]'::jsonb) AS basket, o.rzp_payment_id
         FROM orders o
         JOIN mandates m ON m.mandate_id = o.mandate_id
    LEFT JOIN quotes q ON q.consumed_by = o.intent_id
        WHERE o.intent_id = $1`,
      [intentId],
    );
    await client.query("COMMIT");

    const row = result.rows[0];
    if (row === undefined) return { ok: false, detail: "no such order" };

    payload = {
      customerRef: row.customer_ref,
      fulfilmentRef: row.fulfilment_ref,
      amountPaise: row.amount_paise,
      items: row.basket,
      paymentId: row.rzp_payment_id,
    };
  } finally {
    client.release();
  }

  if (payload.customerRef === null) {
    // The mandate was granted without the merchant saying who their customer is, which
    // happens for a purely external agent at a merchant the shopper has no account with.
    // Nothing is wrong with the payment; there is simply nowhere to file the order.
    logger.warn(`no customer_ref for ${intentId} — nothing to fulfil against`);
    return { ok: false, detail: "mandate has no customer_ref" };
  }

  // INV-19: refuses outright if a mandate row lock is held. This runs after settlement.
  assertEgressPermitted(options.fulfilUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);

  try {
    const response = await fetch(options.fulfilUrl, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", "X-AgentKit-Token": options.token },
      body: JSON.stringify({
        intent_id: intentId,
        customer_ref: payload.customerRef,
        fulfilment_ref: payload.fulfilmentRef,
        items: payload.items,
        amount_paise: payload.amountPaise,
        payment_id: payload.paymentId,
        audit_url: `${options.publicBaseUrl}/agent/audit/${intentId}`,
      }),
    });

    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      order_id?: string;
    };

    if (!response.ok) {
      logger.error(`merchant refused fulfilment for ${intentId}: ${body.error ?? response.status}`);
      logger.count("fulfilment.refused");
      return { ok: false, detail: body.error ?? `merchant returned ${response.status}` };
    }

    logger.count("fulfilment.recorded");
    return { ok: true, detail: body.order_id };
  } catch (error) {
    // The money moved. A merchant that cannot be reached does not undo that, and
    // retrying the payment would be far worse than retrying this call.
    logger.error(`could not reach the merchant to fulfil ${intentId}`, error);
    logger.count("fulfilment.unreachable");
    return { ok: false, detail: "merchant unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
