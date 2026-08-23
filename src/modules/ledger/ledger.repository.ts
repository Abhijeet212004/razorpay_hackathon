import type { PoolClient } from "pg";
import type { JsonValue } from "../../shared/crypto/jcs.js";
import type { LedgerEntry, LedgerKind } from "./ledger.validation.js";

export interface StoredEntry extends LedgerEntry {
  readonly merchantId: string;
  readonly ref: string | null;
  readonly payloadRedacted: JsonValue;
}

/**
 * The current head of a chain. Read under the mandate row lock, so no two appenders can
 * see the same tail.
 */
export async function readHead(
  client: PoolClient,
  chainId: string,
): Promise<LedgerEntry | null> {
  const result = await client.query<{
    chain_id: string;
    seq_text: string;
    prev_hash: Buffer;
    hash: Buffer;
    kind: LedgerKind;
  }>(
    // seq is cast to text because BIGINT would arrive as a JS number, and it is aliased
    // because an output column named `seq` would capture ORDER BY and sort the sequence
    // lexicographically: '9' sorts above '10'.
    `SELECT chain_id, seq::text AS seq_text, prev_hash, hash, kind
       FROM ledger
      WHERE chain_id = $1
      ORDER BY ledger.seq DESC
      LIMIT 1`,
    [chainId],
  );

  const row = result.rows[0];
  if (row === undefined) return null;

  return {
    chainId: row.chain_id,
    seq: Number(row.seq_text),
    prevHash: row.prev_hash,
    hash: row.hash,
    kind: row.kind,
  };
}

export async function insertEntry(client: PoolClient, entry: StoredEntry): Promise<void> {
  await client.query(
    `INSERT INTO ledger (chain_id, seq, prev_hash, hash, kind, merchant_id, ref, payload_redacted)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      entry.chainId,
      entry.seq,
      entry.prevHash,
      entry.hash,
      entry.kind,
      entry.merchantId,
      entry.ref,
      JSON.stringify(entry.payloadRedacted),
    ],
  );
}

/** Every entry on a chain, in sequence order, for hash recomputation. */
export async function readChain(
  client: PoolClient,
  chainId: string,
): Promise<StoredEntry[]> {
  const result = await client.query<{
    chain_id: string;
    seq_text: string;
    prev_hash: Buffer;
    hash: Buffer;
    kind: LedgerKind;
    merchant_id: string;
    ref: string | null;
    payload_redacted: JsonValue;
  }>(
    `SELECT chain_id, seq::text AS seq_text, prev_hash, hash, kind, merchant_id, ref,
            payload_redacted
       FROM ledger
      WHERE chain_id = $1
      ORDER BY ledger.seq`,
    [chainId],
  );

  return result.rows.map((row) => ({
    chainId: row.chain_id,
    seq: Number(row.seq_text),
    prevHash: row.prev_hash,
    hash: row.hash,
    kind: row.kind,
    merchantId: row.merchant_id,
    ref: row.ref,
    payloadRedacted: row.payload_redacted,
  }));
}

export interface LockedMerchant {
  merchantId: string;
  chainHeadSeq: number | null;
}

/**
 * Takes the merchant row lock. The operations chain uses chain_id = merchant_id and
 * serialises here, exactly as a mandate's chain serialises on the mandate row.
 */
export async function lockMerchant(
  client: PoolClient,
  merchantId: string,
): Promise<LockedMerchant | null> {
  const result = await client.query<{ merchant_id: string; chain_head_seq: string | null }>(
    `SELECT merchant_id, chain_head_seq::text AS chain_head_seq
       FROM merchants WHERE merchant_id = $1 FOR UPDATE`,
    [merchantId],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        merchantId: row.merchant_id,
        chainHeadSeq: row.chain_head_seq === null ? null : Number(row.chain_head_seq),
      };
}

export async function updateMerchantChainHead(
  client: PoolClient,
  merchantId: string,
  seq: number,
  hash: Buffer,
): Promise<void> {
  await client.query(
    `UPDATE merchants SET chain_head_seq = $2, chain_head_hash = $3 WHERE merchant_id = $1`,
    [merchantId, seq, hash],
  );
}

/** Every chain id that has at least one entry, for whole-ledger verification. */
export async function listChainIds(client: PoolClient): Promise<string[]> {
  const result = await client.query<{ chain_id: string }>(
    `SELECT DISTINCT chain_id FROM ledger ORDER BY chain_id`,
  );
  return result.rows.map((row) => row.chain_id);
}
