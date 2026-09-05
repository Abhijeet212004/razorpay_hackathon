import type { Pool } from "pg";
import { setMerchantContext } from "../../shared/db/merchant-context.js";

/**
 * Everything the console reads. It connects as agentkit_console, which is SELECT-only and
 * row level security scoped, so a bug here cannot write history or read another
 * merchant's — the console's read-only-ness is a grant, not a convention.
 */

async function scoped<T>(pool: Pool, merchantId: string, fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> {
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

export interface DecisionRow {
  intentId: string;
  chainId: string;
  seq: number;
  verdict: string;
  reasonCode: string;
  amountPaise: string | null;
  createdAt: Date;
}

export async function recentDecisions(
  pool: Pool,
  merchantId: string,
  limit = 60,
): Promise<DecisionRow[]> {
  return scoped(pool, merchantId, async (client) => {
    const result = await client.query<{
      ref: string; chain_id: string; seq: string;
      verdict: string; reason_code: string; amount_paise: string | null; created_at: Date;
    }>(
      `SELECT d.ref,
              d.chain_id,
              d.seq::text AS seq,
              d.payload_redacted -> 'payload' ->> 'verdict'     AS verdict,
              d.payload_redacted -> 'payload' ->> 'reason_code' AS reason_code,
              i.payload_redacted -> 'payload' ->> 'amount_paise' AS amount_paise,
              d.created_at
         FROM ledger d
    LEFT JOIN ledger i ON i.chain_id = d.chain_id AND i.ref = d.ref AND i.kind = 'INTENT'
        WHERE d.kind = 'DECISION'
        ORDER BY d.created_at DESC
        LIMIT $1`,
      [limit],
    );
    return result.rows.map((r) => ({
      intentId: r.ref,
      chainId: r.chain_id,
      seq: Number(r.seq),
      verdict: r.verdict ?? "?",
      reasonCode: r.reason_code ?? "?",
      amountPaise: r.amount_paise,
      createdAt: r.created_at,
    }));
  });
}

export interface MandateRow {
  mandateId: string;
  state: string;
  cumulativePaise: string;
  spentPaise: string;
  silentThresholdPaise: string;
  notAfter: Date;
  chainEntries: number;
}

export async function mandates(pool: Pool, merchantId: string): Promise<MandateRow[]> {
  return scoped(pool, merchantId, async (client) => {
    const result = await client.query<{
      mandate_id: string; state: string; cumulative_paise: string; spent: string;
      silent_threshold_paise: string; not_after: Date; entries: string;
    }>(
      `SELECT m.mandate_id, m.state,
              m.cumulative_paise::text,
              m.silent_threshold_paise::text,
              m.not_after,
              COALESCE((SELECT SUM(amount_paise) FROM reservations r
                         WHERE r.mandate_id = m.mandate_id
                           AND r.state IN ('held','captured')
                           AND r.created_at > now() - m.cumulative_window), 0)::text AS spent,
              (SELECT COUNT(*) FROM ledger l WHERE l.chain_id = m.mandate_id)::text AS entries
         FROM mandates m
        ORDER BY m.created_at DESC`,
    );
    return result.rows.map((r) => ({
      mandateId: r.mandate_id,
      state: r.state,
      cumulativePaise: r.cumulative_paise,
      spentPaise: r.spent,
      silentThresholdPaise: r.silent_threshold_paise,
      notAfter: r.not_after,
      chainEntries: Number(r.entries),
    }));
  });
}

export interface TraceEntry {
  seq: number;
  kind: string;
  createdAt: Date;
  payload: unknown;
}

/** The audit trail for one intent: every entry on its chain that references it. */
export async function trace(
  pool: Pool,
  merchantId: string,
  intentId: string,
): Promise<TraceEntry[]> {
  return scoped(pool, merchantId, async (client) => {
    const result = await client.query<{
      seq: string; kind: string; created_at: Date; payload: unknown;
    }>(
      `SELECT seq::text AS seq, kind, created_at, payload_redacted -> 'payload' AS payload
         FROM ledger WHERE ref = $1 ORDER BY ledger.seq`,
      [intentId],
    );
    return result.rows.map((r) => ({
      seq: Number(r.seq),
      kind: r.kind,
      createdAt: r.created_at,
      payload: r.payload,
    }));
  });
}

/** The whole chain an intent sits on, with the raw hashes, for recomputation. */
export interface ChainEntry {
  seq: number;
  kind: string;
  createdAt: Date;
  ref: string | null;
  /** Exactly the object that was hashed: envelope and all, not just the inner payload. */
  hashedPayload: unknown;
  prevHash: Buffer;
  hash: Buffer;
}

/**
 * Every entry on the chain that contains this intent, oldest first.
 *
 * `trace` returns the inner payload, which is what a reader wants. This returns the whole
 * envelope and both hashes, because verifying the chain means hashing exactly the bytes
 * that were hashed originally, not a convenient subset of them.
 */
export async function chainForIntent(
  pool: Pool,
  merchantId: string,
  intentId: string,
): Promise<{ chainId: string | null; entries: ChainEntry[] }> {
  return scoped(pool, merchantId, async (client) => {
    const found = await client.query<{ chain_id: string }>(
      `SELECT chain_id FROM ledger WHERE ref = $1 LIMIT 1`,
      [intentId],
    );
    const chainId = found.rows[0]?.chain_id ?? null;
    if (chainId === null) return { chainId: null, entries: [] };

    const result = await client.query<{
      seq: string; kind: string; created_at: Date; ref: string | null;
      payload_redacted: unknown; prev_hash: Buffer; hash: Buffer;
    }>(
      // ledger.seq, not the alias: ORDER BY binds to the output column, and the alias is
      // the ::text cast, which sorts 0, 1, 10, 11, 2 and walks the chain out of order.
      `SELECT seq::text AS seq, kind, created_at, ref, payload_redacted, prev_hash, hash
         FROM ledger WHERE chain_id = $1 ORDER BY ledger.seq`,
      [chainId],
    );

    return {
      chainId,
      entries: result.rows.map((r) => ({
        seq: Number(r.seq),
        kind: r.kind,
        createdAt: r.created_at,
        ref: r.ref,
        hashedPayload: r.payload_redacted,
        prevHash: r.prev_hash,
        hash: r.hash,
      })),
    };
  });
}

export async function denialCounts(
  pool: Pool,
  merchantId: string,
): Promise<Array<{ reasonCode: string; count: number }>> {
  return scoped(pool, merchantId, async (client) => {
    const result = await client.query<{ reason_code: string; count: string }>(
      `SELECT payload_redacted -> 'payload' ->> 'reason_code' AS reason_code,
              COUNT(*)::text AS count
         FROM ledger WHERE kind = 'DECISION'
        GROUP BY 1 ORDER BY 2 DESC, 1`,
    );
    return result.rows.map((r) => ({ reasonCode: r.reason_code ?? "?", count: Number(r.count) }));
  });
}

/** The quarantined items: present in the catalog, never priced, visible as such. */
export async function quarantined(
  pool: Pool,
  merchantId: string,
): Promise<Array<{ sku: string; name: string }>> {
  return scoped(pool, merchantId, async (client) => {
    const result = await client.query<{ sku: string; name: string }>(
      `SELECT sku, name FROM catalog_items WHERE NOT active ORDER BY sku`,
    );
    return result.rows;
  });
}
