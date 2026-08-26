import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { generateKeyPair } from "../../shared/crypto/ed25519.js";
import { setMerchantContext } from "../../shared/db/merchant-context.js";

/**
 * A session is an identity, not an authority.
 *
 * An MCP client cannot hold a key or canonicalise a payload, so the kernel keeps a
 * session-scoped keypair and signs on its behalf. What that buys the client is the
 * ability to be *recognised* — nothing more. Every purchase still needs a mandate a human
 * granted to this specific agent, and still faces every check under the row lock.
 *
 * The session token is high-entropy and never derived from anything guessable. It is
 * returned once and stored only as part of the session row, which the console role cannot
 * read.
 */

export interface McpSession {
  sessionId: string;
  agentId: string;
  clientName: string;
  privateKey: Buffer;
  expiresAt: Date;
}

const SESSION_TTL_MS = 12 * 60 * 60_000;

async function scoped<T>(
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

export async function createSession(
  pool: Pool,
  merchantId: string,
  clientName: string,
): Promise<McpSession> {
  const keys = generateKeyPair();
  const agentId = `agt_mcp_${randomUUID()}`;
  // 256 bits. A session token is a bearer credential and is treated as one.
  const sessionId = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await scoped(pool, merchantId, async (client) => {
    await client.query(
      `INSERT INTO agents (agent_id, name, public_key, attestation)
       VALUES ($1, $2, $3, 'mcp_session_v1')`,
      [agentId, `MCP · ${clientName}`.slice(0, 190), keys.publicKey],
    );
    await client.query(
      `INSERT INTO mcp_sessions (session_id, merchant_id, agent_id, client_name,
         private_key, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sessionId, merchantId, agentId, clientName.slice(0, 190), keys.privateKey, expiresAt],
    );
  });

  return { sessionId, agentId, clientName, privateKey: keys.privateKey, expiresAt };
}

/** Returns null for an unknown, expired or revoked session. All three look identical. */
export async function resolveSession(
  pool: Pool,
  merchantId: string,
  sessionId: string | undefined,
): Promise<McpSession | null> {
  if (sessionId === undefined || sessionId.length < 16) return null;

  return scoped(pool, merchantId, async (client) => {
    const result = await client.query<{
      session_id: string;
      agent_id: string;
      client_name: string;
      private_key: Buffer;
      expires_at: Date;
    }>(
      `SELECT session_id, agent_id, client_name, private_key, expires_at
         FROM mcp_sessions
        WHERE session_id = $1
          AND revoked_at IS NULL
          AND expires_at > now()`,
      [sessionId],
    );

    const row = result.rows[0];
    if (row === undefined) return null;

    await client.query(
      `UPDATE mcp_sessions SET last_seen_at = now() WHERE session_id = $1`,
      [sessionId],
    );

    return {
      sessionId: row.session_id,
      agentId: row.agent_id,
      clientName: row.client_name,
      privateKey: row.private_key,
      expiresAt: row.expires_at,
    };
  });
}

export async function revokeSession(
  pool: Pool,
  merchantId: string,
  sessionId: string,
): Promise<boolean> {
  return scoped(pool, merchantId, async (client) => {
    const result = await client.query(
      `UPDATE mcp_sessions SET revoked_at = now()
        WHERE session_id = $1 AND revoked_at IS NULL`,
      [sessionId],
    );
    return result.rowCount === 1;
  });
}
