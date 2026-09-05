import type { Pool } from "pg";
import * as repository from "./audit.repository.js";
import type { AuditRecord } from "./audit.validation.js";

/**
 * What happened to one intent, as a reader can check it.
 *
 * The entries carry their own hashes, so the chain is verifiable here rather than taken on
 * trust: entry n must name entry n-1. A gap or a rewrite shows up as chain_intact false
 * instead of being quietly presented as a clean history. The ledger is append-only and
 * UPDATE, DELETE and TRUNCATE are revoked, so this should never be false — which is
 * exactly why it is worth reporting when it is.
 */
export async function record(pool: Pool, intentId: string): Promise<AuditRecord | null> {
  const entries = await repository.byIntent(pool, intentId);
  if (entries.length === 0) return null;

  let intact = true;
  for (let i = 1; i < entries.length; i += 1) {
    if (entries[i]!.prev_hash !== entries[i - 1]!.hash) intact = false;
  }

  return { intent_id: intentId, entries, chain_intact: intact };
}
