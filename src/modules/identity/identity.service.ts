import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { generateKeyPair } from "../../shared/crypto/ed25519.js";
import * as repo from "./identity.repository.js";
import type {
  KeyPurpose,
  RecordAuthEventInput,
  RegisterAgentInput,
} from "./identity.validation.js";

/**
 * Registration is identity only, never authority. A registered agent that holds no
 * mandate is denied on every money call, so this endpoint can stay open: there is no
 * partnership call and no key exchange.
 */
export async function registerAgent(
  pool: Pool,
  input: RegisterAgentInput,
): Promise<{ agentId: string; attestation: string }> {
  const agentId = `agt_${randomUUID()}`;
  const attestation = "self_registered_v1";

  await pool.query(
    `INSERT INTO agents (agent_id, name, public_key, attestation) VALUES ($1, $2, $3, $4)`,
    [agentId, input.name, Buffer.from(input.public_key, "hex"), attestation],
  );

  return { agentId, attestation };
}

/**
 * A mandate binds a fresh authentication event. Ambient session state is not consent, so
 * the event is a row with its own timestamp rather than a flag on a session.
 */
export async function recordAuthEvent(
  pool: Pool,
  input: RecordAuthEventInput,
): Promise<{ authEventId: string }> {
  const authEventId = `aev_${randomUUID()}`;
  await pool.query(
    `INSERT INTO auth_events (auth_event_id, subject_pseudonym, method, max_age_seconds)
     VALUES ($1, $2, $3, $4)`,
    [authEventId, input.subject_pseudonym, input.method, input.max_age_seconds],
  );
  return { authEventId };
}

/** True while the event is inside the freshness bound it was recorded with. */
export async function isAuthEventFresh(
  pool: Pool,
  authEventId: string,
  now: Date,
): Promise<boolean> {
  const result = await pool.query<{ fresh: boolean }>(
    `SELECT (occurred_at + make_interval(secs => max_age_seconds)) > $2 AS fresh
       FROM auth_events WHERE auth_event_id = $1`,
    [authEventId, now.toISOString()],
  );
  return result.rows[0]?.fresh ?? false;
}

/**
 * INV-16: every signature carries a kid; verification accepts retired keys and only
 * issuance uses the active one.
 *
 * Rotation: the outgoing key is retired, not deleted, because verification must keep
 * accepting signatures it already made. Only issuance is restricted to the active key,
 * and the partial unique index makes two active keys for one purpose unwritable.
 */
export async function rotateSigningKey(
  pool: Pool,
  purpose: KeyPurpose,
): Promise<{ kid: string; retired: string | null }> {
  const { publicKey, privateKey } = generateKeyPair();
  const kid = `kid_${purpose}_${randomUUID().slice(0, 12)}`;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const previous = await client.query<{ kid: string }>(
      `UPDATE signing_keys SET state = 'retired', retired_at = now()
        WHERE purpose = $1 AND state = 'active'
        RETURNING kid`,
      [purpose],
    );

    await client.query(
      `INSERT INTO signing_keys (kid, purpose, state, public_key, private_key)
       VALUES ($1, $2, 'active', $3, $4)`,
      [kid, purpose, publicKey, privateKey],
    );

    await client.query("COMMIT");
    return { kid, retired: previous.rows[0]?.kid ?? null };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export const findAgent = repo.findAgent;
export const findVerificationKey = repo.findVerificationKey;
export const findActiveKey = repo.findActiveKey;
