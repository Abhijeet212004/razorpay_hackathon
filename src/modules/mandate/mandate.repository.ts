import type { PoolClient } from "pg";
import type { IssueMandateInput } from "./mandate.validation.js";

export interface MandateRevocationState {
  mandateId: string;
  merchantId: string;
  state: "live" | "revoked" | "expired";
}

/**
 * The same SELECT ... FOR UPDATE the authorisation path takes. Revocation and
 * authorisation contend for one row, so a mandate cannot be revoked while an
 * authorisation against it is mid-flight, nor authorised while a revocation is.
 */
export async function lockForRevoke(
  client: PoolClient,
  mandateId: string,
): Promise<MandateRevocationState | null> {
  const result = await client.query<{
    mandate_id: string;
    merchant_id: string;
    state: "live" | "revoked" | "expired";
  }>(
    `SELECT mandate_id, merchant_id, state FROM mandates WHERE mandate_id = $1 FOR UPDATE`,
    [mandateId],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : { mandateId: row.mandate_id, merchantId: row.merchant_id, state: row.state };
}

export async function markRevoked(client: PoolClient, mandateId: string): Promise<void> {
  await client.query(
    `UPDATE mandates SET state = 'revoked', revoked_at = now() WHERE mandate_id = $1`,
    [mandateId],
  );
}

/** Reservations still held at the moment of revocation, read under the same lock. */
export async function heldReservations(
  client: PoolClient,
  mandateId: string,
): Promise<string[]> {
  const result = await client.query<{ reservation_id: string }>(
    `SELECT reservation_id FROM reservations WHERE mandate_id = $1 AND state = 'held'`,
    [mandateId],
  );
  return result.rows.map((row) => row.reservation_id);
}

export async function insert(
  client: PoolClient,
  mandateId: string,
  input: IssueMandateInput,
  kid: string,
  signature: Buffer,
): Promise<void> {
  await client.query(
    `INSERT INTO mandates (
       mandate_id, merchant_id, subject_pseudonym, agent_id, auth_event_id,
       per_transaction_paise, cumulative_paise, cumulative_window, velocity_per_hour,
       silent_threshold_paise, scope, state, not_before, not_after, chain_id, kid, signature
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::interval,$9,$10,$11::jsonb,'live',$12,$13,$1,$14,$15)`,
    [
      mandateId,
      input.merchant_id,
      input.subject_pseudonym,
      input.agent_id,
      input.auth_event_id,
      input.limits.per_transaction_paise.toString(),
      input.limits.cumulative_paise.toString(),
      input.limits.cumulative_window,
      input.limits.velocity_per_hour,
      input.limits.silent_threshold_paise.toString(),
      JSON.stringify(input.scope),
      input.not_before,
      input.not_after,
      kid,
      signature,
    ],
  );
}
