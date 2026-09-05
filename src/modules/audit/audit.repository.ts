import type { Pool } from "pg";
import type { AuditEntry } from "./audit.validation.js";

interface Row {
  kind: string;
  seq: string;
  hash: Buffer;
  prev_hash: Buffer;
  payload: unknown;
  created_at: Date;
}

/**
 * Every ledger entry written against one intent, oldest first.
 *
 * Read through audit_by_intent, a SECURITY DEFINER function, because the reader is
 * unauthenticated and so has no tenant context for row level security to scope by. The
 * intent id is a random UUID: knowing it is the capability.
 */
export async function byIntent(pool: Pool, intentId: string): Promise<readonly AuditEntry[]> {
  const result = await pool.query<Row>(
    `SELECT kind, seq, hash, prev_hash, payload, created_at FROM audit_by_intent($1)`,
    [intentId],
  );

  return result.rows.map((row) => ({
    kind: row.kind,
    seq: Number(row.seq),
    hash: row.hash.toString("hex"),
    prev_hash: row.prev_hash.toString("hex"),
    at: row.created_at.toISOString(),
    detail: row.payload,
  }));
}
