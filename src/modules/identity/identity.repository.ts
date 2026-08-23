import type { Pool, PoolClient } from "pg";

export interface AgentIdentity {
  agentId: string;
  publicKey: Buffer;
  attestation: string;
}

export interface VerificationKey {
  kid: string;
  purpose: string;
  state: "active" | "retired";
  publicKey: Buffer;
}

/** Read outside the transaction: signature checking must not hold the mandate row lock. */
export async function findAgent(
  db: Pool | PoolClient,
  agentId: string,
): Promise<AgentIdentity | null> {
  const result = await db.query<{ agent_id: string; public_key: Buffer; attestation: string }>(
    `SELECT agent_id, public_key, attestation FROM agents WHERE agent_id = $1`,
    [agentId],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : { agentId: row.agent_id, publicKey: row.public_key, attestation: row.attestation };
}

/** Verification accepts retired keys; only issuance is restricted to the active one. */
export async function findVerificationKey(
  db: Pool | PoolClient,
  kid: string,
): Promise<VerificationKey | null> {
  const result = await db.query<{
    kid: string;
    purpose: string;
    state: "active" | "retired";
    public_key: Buffer;
  }>(`SELECT kid, purpose, state, public_key FROM signing_keys WHERE kid = $1`, [kid]);
  const row = result.rows[0];
  return row === undefined
    ? null
    : { kid: row.kid, purpose: row.purpose, state: row.state, publicKey: row.public_key };
}

export async function findActiveKey(
  db: Pool | PoolClient,
  purpose: string,
): Promise<VerificationKey | null> {
  const result = await db.query<{
    kid: string;
    purpose: string;
    state: "active" | "retired";
    public_key: Buffer;
  }>(
    `SELECT kid, purpose, state, public_key FROM signing_keys
      WHERE purpose = $1 AND state = 'active'`,
    [purpose],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : { kid: row.kid, purpose: row.purpose, state: row.state, publicKey: row.public_key };
}
