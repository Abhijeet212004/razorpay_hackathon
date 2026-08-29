import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Paise } from "../../shared/money.js";

/**
 * Every read and write the authorisation transaction performs. All of these run with the
 * mandate row lock already held, except lockMandate, which takes it.
 */

const UNIQUE_VIOLATION = "23505";

function sqlstateOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

export interface LockedMandate {
  mandateId: string;
  merchantId: string;
  agentId: string;
  state: "live" | "revoked" | "expired";
  notBefore: Date;
  notAfter: Date;
  perTransactionPaise: Paise;
  cumulativePaise: Paise;
  cumulativeWindow: string;
  velocityPerHour: number;
  silentThresholdPaise: Paise;
  allowedMerchants: readonly string[];
  allowedCategories: readonly string[];
  authEventId: string | null;
  customerRef: string | null;
  fulfilmentRef: string | null;
  chainHeadSeq: number | null;
  chainHeadHash: Buffer | null;
}

interface MandateScope {
  merchants?: unknown;
  categories?: unknown;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Takes the row lock. Every authoriser for this mandate serialises here, and the
 * mandate's hash chain inherits the same lock.
 *
 * Row level security scopes this to the deployment's merchant, so a mandate belonging to
 * another merchant is simply not visible and denies as unknown.
 */
export async function lockMandate(
  client: PoolClient,
  mandateId: string,
): Promise<LockedMandate | null> {
  const result = await client.query<{
    mandate_id: string;
    merchant_id: string;
    agent_id: string;
    state: "live" | "revoked" | "expired";
    not_before: Date;
    not_after: Date;
    per_transaction_paise: string;
    cumulative_paise: string;
    cumulative_window: string;
    velocity_per_hour: number;
    silent_threshold_paise: string;
    scope: MandateScope;
    auth_event_id: string | null;
    customer_ref: string | null;
    fulfilment_ref: string | null;
    chain_head_seq: string | null;
    chain_head_hash: Buffer | null;
  }>(
    `SELECT mandate_id, merchant_id, agent_id, state, not_before, not_after,
            per_transaction_paise::text, cumulative_paise::text,
            cumulative_window::text, velocity_per_hour, silent_threshold_paise::text,
            scope, auth_event_id, customer_ref, fulfilment_ref,
            chain_head_seq::text, chain_head_hash
       FROM mandates
      WHERE mandate_id = $1
      FOR UPDATE`,
    [mandateId],
  );

  const row = result.rows[0];
  if (row === undefined) return null;

  return {
    mandateId: row.mandate_id,
    merchantId: row.merchant_id,
    agentId: row.agent_id,
    state: row.state,
    notBefore: row.not_before,
    notAfter: row.not_after,
    perTransactionPaise: BigInt(row.per_transaction_paise),
    cumulativePaise: BigInt(row.cumulative_paise),
    cumulativeWindow: row.cumulative_window,
    velocityPerHour: row.velocity_per_hour,
    silentThresholdPaise: BigInt(row.silent_threshold_paise),
    allowedMerchants: stringArray(row.scope?.merchants),
    allowedCategories: stringArray(row.scope?.categories),
    authEventId: row.auth_event_id,
    customerRef: row.customer_ref,
    fulfilmentRef: row.fulfilment_ref,
    chainHeadSeq: row.chain_head_seq === null ? null : Number(row.chain_head_seq),
    chainHeadHash: row.chain_head_hash,
  };
}

/**
 * INV-05: the cap sum counts held and captured reservations, not settled payments.
 *
 * Counting only settled amounts lets two sequential intents each read a total that
 * excludes the other, because settlement lags authorisation by seconds to minutes. The
 * row lock stops simultaneous reads; it does not stop sequential reads of stale state.
 */
export async function sumReservedAndCaptured(
  client: PoolClient,
  mandateId: string,
  window: string,
): Promise<Paise> {
  const result = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_paise), 0)::text AS total
       FROM reservations
      WHERE mandate_id = $1
        AND state IN ('held', 'captured')
        AND created_at > now() - $2::interval`,
    [mandateId, window],
  );
  return BigInt(result.rows[0]?.total ?? "0");
}

/** Spend velocity, counted from reservations for the same reason the cap sum is. */
export async function countReservationsLastHour(
  client: PoolClient,
  mandateId: string,
): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM reservations
      WHERE mandate_id = $1
        AND state IN ('held', 'captured')
        AND created_at > now() - INTERVAL '1 hour'`,
    [mandateId],
  );
  return Number(result.rows[0]?.count ?? "0");
}

/** Whether this mandate has already settled a purchase at this merchant. */
export async function hasCapturedAtMerchant(
  client: PoolClient,
  mandateId: string,
  merchantId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
       FROM reservations
      WHERE mandate_id = $1 AND merchant_id = $2 AND state = 'captured'
      LIMIT 1`,
    [mandateId, merchantId],
  );
  return result.rowCount !== null && result.rowCount > 0;
}

export async function isAgentRegistered(
  client: PoolClient,
  agentId: string,
): Promise<boolean> {
  const result = await client.query(`SELECT 1 FROM agents WHERE agent_id = $1`, [agentId]);
  return result.rowCount !== null && result.rowCount > 0;
}

/**
 * The insert is the burn: the primary key does the work, so there is no read-then-write
 * and no race. Returns false on a duplicate, which the caller denies as a spent nonce.
 * A rolled-back attempt releases the nonce with the transaction; a committed denial
 * keeps it spent.
 *
 * The savepoint matters. A constraint violation aborts the whole transaction in
 * PostgreSQL, so without it a replayed nonce would poison every later statement — the
 * decision could not be evaluated and the denial could not be written to the ledger.
 */
export async function burnNonce(
  client: PoolClient,
  nonce: { nonce: string; mandateId: string; intentId: string },
): Promise<boolean> {
  await client.query("SAVEPOINT burn_nonce");
  try {
    await client.query(
      `INSERT INTO intent_nonces (nonce, mandate_id, intent_id) VALUES ($1, $2, $3)`,
      [nonce.nonce, nonce.mandateId, nonce.intentId],
    );
    await client.query("RELEASE SAVEPOINT burn_nonce");
    return true;
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT burn_nonce");
    if (sqlstateOf(error) === UNIQUE_VIOLATION) return false;
    throw error;
  }
}

export interface NewReservation {
  mandateId: string;
  merchantId: string;
  intentId: string;
  amountPaise: Paise;
  stepUp: boolean;
}

/**
 * Written inside the lock, in the same transaction as the cap read that admitted it.
 * Splitting these two is the concurrency bug the reservation model exists to prevent.
 */
export async function insertReservation(
  client: PoolClient,
  reservation: NewReservation,
): Promise<string> {
  const reservationId = `rsv_${randomUUID()}`;
  await client.query(
    `INSERT INTO reservations (
       reservation_id, mandate_id, merchant_id, intent_id, amount_paise, state, step_up
     ) VALUES ($1, $2, $3, $4, $5, 'held', $6)`,
    [
      reservationId,
      reservation.mandateId,
      reservation.merchantId,
      reservation.intentId,
      reservation.amountPaise.toString(),
      reservation.stepUp,
    ],
  );
  return reservationId;
}

export async function updateChainHead(
  client: PoolClient,
  mandateId: string,
  seq: number,
  hash: Buffer,
): Promise<void> {
  await client.query(
    `UPDATE mandates SET chain_head_seq = $2, chain_head_hash = $3 WHERE mandate_id = $1`,
    [mandateId, seq, hash],
  );
}

export interface NewChallenge {
  challengeId: string;
  intentId: string;
  mandateId: string;
  merchantId: string;
  amountPaise: Paise;
  expiresAt: Date;
}

/**
 * The single-use challenge a step-up is approved against. Its TTL is shorter than the
 * quote's, so an approval can never arrive against a price that has already expired.
 */
export async function insertChallenge(
  client: PoolClient,
  challenge: NewChallenge,
): Promise<void> {
  await client.query(
    `INSERT INTO challenges (challenge_id, intent_id, mandate_id, merchant_id,
       amount_paise, state, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
    [
      challenge.challengeId,
      challenge.intentId,
      challenge.mandateId,
      challenge.merchantId,
      challenge.amountPaise.toString(),
      challenge.expiresAt.toISOString(),
    ],
  );
}

export interface PendingChallenge {
  challengeId: string;
  intentId: string;
  mandateId: string;
  merchantId: string;
  amountPaise: Paise;
  state: string;
  expiresAt: Date;
}

export async function findChallenge(
  client: PoolClient,
  challengeId: string,
): Promise<PendingChallenge | null> {
  const result = await client.query<{
    challenge_id: string;
    intent_id: string;
    mandate_id: string;
    merchant_id: string;
    amount_paise: string;
    state: string;
    expires_at: Date;
  }>(
    `SELECT challenge_id, intent_id, mandate_id, merchant_id, amount_paise::text,
            state, expires_at
       FROM challenges WHERE challenge_id = $1`,
    [challengeId],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        challengeId: row.challenge_id,
        intentId: row.intent_id,
        mandateId: row.mandate_id,
        merchantId: row.merchant_id,
        amountPaise: BigInt(row.amount_paise),
        state: row.state,
        expiresAt: row.expires_at,
      };
}

export async function resolveChallenge(
  client: PoolClient,
  challengeId: string,
  state: "approved" | "rejected",
): Promise<boolean> {
  const result = await client.query(
    `UPDATE challenges SET state = $2, resolved_at = now()
      WHERE challenge_id = $1 AND state = 'pending'`,
    [challengeId, state],
  );
  return result.rowCount === 1;
}

export async function reservationState(
  client: PoolClient,
  intentId: string,
): Promise<string | null> {
  const result = await client.query<{ state: string }>(
    `SELECT state FROM reservations WHERE intent_id = $1`,
    [intentId],
  );
  return result.rows[0]?.state ?? null;
}
