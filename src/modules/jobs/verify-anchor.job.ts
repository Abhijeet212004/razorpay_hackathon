import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { signPayload } from "../../shared/crypto/ed25519.js";
import { withAuthorizationTransaction } from "../../shared/db/transaction.js";
import { listChainIds } from "../ledger/ledger.repository.js";
import { verifyChain } from "../ledger/ledger.service.js";
import type { JobResult } from "./jobs.validation.js";

/**
 * Walks every chain, then checkpoints the heads.
 *
 * The anchor is signed with a dedicated anchor key so the checkpoint is independently
 * attributable. It is deliberately low-value: forging an anchor cannot forge history,
 * because every per-mandate chain independently contradicts a false checkpoint.
 *
 * A broken chain halts that mandate rather than being repaired. Repairing tamper evidence
 * is indistinguishable from tampering.
 */
export async function verifyAndAnchor(
  pool: Pool,
  merchantId: string,
): Promise<JobResult & { broken: readonly string[] }> {
  const options = {
    merchantId,
    lockTimeoutMs: 3_000,
    statementTimeoutMs: 10_000,
    retryAttempts: 3,
    retryBackoffMs: [10, 40, 160],
  };

  return withAuthorizationTransaction(pool, options, async (client) => {
    const chainIds = await listChainIds(client);
    const heads: Array<{ chain_id: string; seq: number; hash: string }> = [];
    const broken: string[] = [];

    for (const chainId of chainIds) {
      const result = await verifyChain(client, chainId);
      if (!result.valid) {
        broken.push(chainId);
        continue;
      }

      const head = await client.query<{ seq: string; hash: Buffer }>(
        `SELECT seq::text AS seq, hash FROM ledger WHERE chain_id = $1
          ORDER BY ledger.seq DESC LIMIT 1`,
        [chainId],
      );
      const row = head.rows[0];
      if (row !== undefined) {
        heads.push({ chain_id: chainId, seq: Number(row.seq), hash: row.hash.toString("hex") });
      }
    }

    const key = await client.query<{ kid: string; private_key: Buffer | null }>(
      `SELECT kid, private_key FROM anchor_signing_keys WHERE state = 'active'`,
    );
    const anchorKey = key.rows[0];

    if (anchorKey?.private_key != null && heads.length > 0) {
      const payload = { chain_heads: heads, merchant_id: merchantId };
      await client.query(
        `INSERT INTO ledger_anchor (anchor_id, chain_heads, kid, sig)
         VALUES ($1, $2::jsonb, $3, $4)`,
        [
          `anc_${randomUUID()}`,
          JSON.stringify(heads),
          anchorKey.kid,
          signPayload(anchorKey.private_key, payload),
        ],
      );
    }

    return {
      job: "verify-chain-anchor",
      examined: chainIds.length,
      changed: heads.length,
      details: heads.map((h) => `${h.chain_id}@${h.seq}`),
      broken,
    };
  });
}
