import type { PoolClient } from "pg";
import type { AgentOrderState, OrderView } from "./orders.validation.js";

/**
 * The agent-facing view of an order. It reads the kernel's own record rather than the
 * merchant's, because this is the record that says why the purchase was permitted.
 */

const AGENT_STATE: Record<string, AgentOrderState> = {
  AUTHORISED: "authorised",
  SUBMITTING: "processing",
  SUBMITTED: "processing",
  AMBIGUOUS: "processing",
  CAPTURED: "completed",
  FAILED: "failed",
  FAILED_UNRESOLVED: "failed",
};

const RECONCILING = new Set(["SUBMITTING", "SUBMITTED", "AMBIGUOUS"]);

interface Row {
  intent_id: string;
  state: string;
  amount_paise: string;
  created_at: Date;
  updated_at: Date;
  basket: unknown;
}

function toView(row: Row): OrderView {
  const items = Array.isArray(row.basket)
    ? (row.basket as { sku: string; quantity: number }[])
    : [];
  return {
    intent_id: row.intent_id,
    state: AGENT_STATE[row.state] ?? "processing",
    amount_paise: row.amount_paise,
    placed_at: row.created_at.toISOString(),
    settled_at: RECONCILING.has(row.state) ? null : row.updated_at.toISOString(),
    items,
    reconciling: RECONCILING.has(row.state),
  };
}

/**
 * The basket comes from the quote the order was placed against — the merchant's own
 * priced line items — so a reorder reprices exactly those SKUs rather than trusting
 * anything the agent remembers.
 */
const SELECT = `
  SELECT o.intent_id, o.state, o.amount_paise::text, o.created_at, o.updated_at,
         COALESCE(q.basket, '[]'::jsonb) AS basket
    FROM orders o
    LEFT JOIN quotes q ON q.consumed_by = o.intent_id`;

export async function byIntent(
  client: PoolClient,
  mandateId: string,
  intentId: string,
): Promise<OrderView | null> {
  const result = await client.query<Row>(
    `${SELECT} WHERE o.intent_id = $1 AND o.mandate_id = $2`,
    [intentId, mandateId],
  );
  const row = result.rows[0];
  return row === undefined ? null : toView(row);
}

export async function history(
  client: PoolClient,
  mandateId: string,
  limit: number,
): Promise<OrderView[]> {
  const result = await client.query<Row>(
    `${SELECT} WHERE o.mandate_id = $1 ORDER BY o.created_at DESC LIMIT $2`,
    [mandateId, Math.min(limit, 50)],
  );
  return result.rows.map(toView);
}

/** The raw state, for the cancel path, which needs the distinction the agent view hides. */
export async function rawState(
  client: PoolClient,
  mandateId: string,
  intentId: string,
): Promise<{ orderId: string; state: string } | null> {
  const result = await client.query<{ order_id: string; state: string }>(
    `SELECT order_id, state FROM orders WHERE intent_id = $1 AND mandate_id = $2`,
    [intentId, mandateId],
  );
  const row = result.rows[0];
  return row === undefined ? null : { orderId: row.order_id, state: row.state };
}


