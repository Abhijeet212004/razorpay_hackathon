import { createHash } from "node:crypto";
import { canonicalBytes, type JsonValue } from "./jcs.js";

/** The prev_hash of every chain's first entry. */
export const GENESIS_PREV_HASH: Buffer = Buffer.alloc(32, 0);

export function sha256(...parts: readonly Buffer[]): Buffer {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

export function sha256Hex(...parts: readonly Buffer[]): string {
  return sha256(...parts).toString("hex");
}

/**
 * One step of a ledger chain: SHA256(prev_hash || JCS(payload)).
 * `agentkit verify` recomputes this from raw rows, so it lives here and nowhere else.
 */
export function chainHash(prevHash: Buffer, payload: JsonValue): Buffer {
  if (prevHash.length !== 32) {
    throw new Error(`prev_hash must be 32 bytes, received ${prevHash.length}`);
  }
  return sha256(prevHash, canonicalBytes(payload));
}

/** INV-04: the idempotency key carried by every money-moving call. */
export function idempotencyKey(intentId: string): string {
  return sha256Hex(Buffer.from(intentId, "utf8"));
}
