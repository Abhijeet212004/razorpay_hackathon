import type { PoolClient } from "pg";
import { GENESIS_PREV_HASH, chainHash } from "../../shared/crypto/hash.js";
import { canonicalise } from "../../shared/crypto/jcs.js";
import { insertEntry, readChain, readHead } from "./ledger.repository.js";
import type { LedgerAppend, LedgerEntry } from "./ledger.validation.js";

/**
 * One hash chain per mandate, appended inside the caller's transaction under the mandate
 * row lock, so two appenders cannot read the same tail. A unique constraint on
 * (chain_id, prev_hash) is the storage-layer backstop: a violation there is a bug or an
 * attack and must not be retried.
 */
export async function append(
  client: PoolClient,
  entry: LedgerAppend,
): Promise<LedgerEntry> {
  const head = await readHead(client, entry.chainId);

  const seq = head === null ? 0 : head.seq + 1;
  const prevHash = head === null ? GENESIS_PREV_HASH : head.hash;

  const payload = {
    chain_id: entry.chainId,
    kind: entry.kind,
    merchant_id: entry.merchantId,
    payload: entry.payloadRedacted,
    ref: entry.ref,
    seq,
  };

  const hash = chainHash(prevHash, payload);

  await insertEntry(client, {
    chainId: entry.chainId,
    seq,
    prevHash,
    hash,
    kind: entry.kind,
    merchantId: entry.merchantId,
    ref: entry.ref,
    payloadRedacted: payload,
  });

  return { chainId: entry.chainId, seq, prevHash, hash, kind: entry.kind };
}

export interface ChainVerification {
  readonly chainId: string;
  readonly entries: number;
  readonly valid: boolean;
  /** Sequence of the first entry that failed, if any. */
  readonly brokenAt: number | null;
}

/**
 * INV-11: verification recomputes every hash from raw rows.
 * Nothing here trusts a stored hash: each entry's
 * hash is derived again from its predecessor and its canonical payload, so a row edited
 * in place is detected even if its own hash column was edited to match.
 */
export async function verifyChain(
  client: PoolClient,
  chainId: string,
): Promise<ChainVerification> {
  const entries = await readChain(client, chainId);

  let expectedPrev = GENESIS_PREV_HASH;

  for (const [index, entry] of entries.entries()) {
    if (entry.seq !== index) {
      return { chainId, entries: entries.length, valid: false, brokenAt: entry.seq };
    }
    if (!entry.prevHash.equals(expectedPrev)) {
      return { chainId, entries: entries.length, valid: false, brokenAt: entry.seq };
    }

    const recomputed = chainHash(expectedPrev, entry.payloadRedacted);
    if (!recomputed.equals(entry.hash)) {
      return { chainId, entries: entries.length, valid: false, brokenAt: entry.seq };
    }

    expectedPrev = entry.hash;
  }

  return { chainId, entries: entries.length, valid: true, brokenAt: null };
}

/** The canonical bytes a chain entry hashes over. Exposed for the verify CLI. */
export function canonicalPayload(entry: { payloadRedacted: unknown }): string {
  return canonicalise(entry.payloadRedacted as never);
}
