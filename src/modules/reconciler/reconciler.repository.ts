import type { PoolClient } from "pg";

const UNIQUE_VIOLATION = "23505";

function sqlstateOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/**
 * INV-15: a provider event is applied at most once. The primary key is the dedupe, taken
 * inside the same transaction as the state transition, so a duplicate delivery cannot
 * apply the transition twice even if both arrive together.
 *
 * The savepoint keeps a duplicate from aborting the transaction, so the caller can carry
 * on and report the duplicate rather than failing the request.
 */
export async function claimEvent(
  client: PoolClient,
  event: { providerEventId: string; merchantId: string; eventType: string; payload: unknown },
): Promise<boolean> {
  await client.query("SAVEPOINT claim_event");
  try {
    await client.query(
      `INSERT INTO webhook_events (provider_event_id, merchant_id, event_type, payload_redacted)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [event.providerEventId, event.merchantId, event.eventType, JSON.stringify(event.payload)],
    );
    await client.query("RELEASE SAVEPOINT claim_event");
    return true;
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT claim_event");
    if (sqlstateOf(error) === UNIQUE_VIOLATION) return false;
    throw error;
  }
}

export async function findOrderByRailId(
  client: PoolClient,
  railOrderId: string,
): Promise<{ orderId: string; intentId: string; mandateId: string; state: string } | null> {
  const result = await client.query<{
    order_id: string;
    intent_id: string;
    mandate_id: string;
    state: string;
  }>(
    `SELECT order_id, intent_id, mandate_id, state FROM orders WHERE rzp_order_id = $1`,
    [railOrderId],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        orderId: row.order_id,
        intentId: row.intent_id,
        mandateId: row.mandate_id,
        state: row.state,
      };
}

/**
 * held -> captured does not need the mandate row lock: both states are counted by the cap
 * query, so the sum is unchanged. Moving a reservation *out* of ('held','captured') does
 * need it, because that changes the sum.
 */
export async function captureReservation(
  client: PoolClient,
  intentId: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE reservations
        SET state = 'captured', resolved_at = now()
      WHERE intent_id = $1 AND state = 'held'`,
    [intentId],
  );
  return result.rowCount === 1;
}
