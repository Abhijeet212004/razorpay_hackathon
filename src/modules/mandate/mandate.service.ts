import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { signPayload } from "../../shared/crypto/ed25519.js";
import type { JsonValue } from "../../shared/crypto/jcs.js";
import { withAuthorizationTransaction } from "../../shared/db/transaction.js";
import { paiseToCanonical } from "../../shared/money.js";
import * as identity from "../identity/identity.repository.js";
import { append } from "../ledger/ledger.service.js";
import * as repo from "./mandate.repository.js";
import type {
  IssueMandateInput,
  RevocationResult,
  RevokeMandateInput,
} from "./mandate.validation.js";

export interface MandateServiceOptions {
  readonly merchantId: string;
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly retryAttempts: number;
  readonly retryBackoffMs: readonly number[];
}

function mandateSigningPayload(mandateId: string, input: IssueMandateInput): JsonValue {
  return {
    agent_id: input.agent_id,
    auth_event_id: input.auth_event_id,
    cumulative_paise: paiseToCanonical(input.limits.cumulative_paise),
    cumulative_window: input.limits.cumulative_window,
    mandate_id: mandateId,
    merchant_id: input.merchant_id,
    not_after: input.not_after,
    not_before: input.not_before,
    per_transaction_paise: paiseToCanonical(input.limits.per_transaction_paise),
    scope_categories: [...input.scope.categories].sort(),
    scope_currency: input.scope.currency,
    scope_merchants: [...input.scope.merchants].sort(),
    silent_threshold_paise: paiseToCanonical(input.limits.silent_threshold_paise),
    subject_pseudonym: input.subject_pseudonym,
    velocity_per_hour: input.limits.velocity_per_hour,
  };
}

/**
 * Issues a mandate and opens its hash chain with a MANDATE_ISSUED entry at sequence zero.
 * The chain id is the mandate id, so the chain exists from the moment the authority does.
 */
export async function issue(
  pool: Pool,
  options: MandateServiceOptions,
  input: IssueMandateInput,
): Promise<{ mandateId: string; ledgerSeq: number }> {
  const activeKey = await identity.findActiveKey(pool, "mandate");
  if (activeKey === null) {
    throw new Error("no active mandate signing key: cannot issue");
  }

  const mandateId = `mnd_${randomUUID()}`;
  const payload = mandateSigningPayload(mandateId, input);
  const signature = signPayload(await privateKeyFor(pool, activeKey.kid), payload);

  return withAuthorizationTransaction(pool, options, async (client) => {
    await repo.insert(client, mandateId, input, activeKey.kid, signature);

    const entry = await append(client, {
      chainId: mandateId,
      kind: "MANDATE_ISSUED",
      merchantId: input.merchant_id,
      ref: mandateId,
      payloadRedacted: payload,
    });

    await client.query(
      `UPDATE mandates SET chain_head_seq = $2, chain_head_hash = $3 WHERE mandate_id = $1`,
      [mandateId, entry.seq, entry.hash],
    );

    return { mandateId, ledgerSeq: entry.seq };
  });
}

async function privateKeyFor(pool: Pool, kid: string): Promise<Buffer> {
  const result = await pool.query<{ private_key: Buffer | null }>(
    `SELECT private_key FROM signing_keys WHERE kid = $1`,
    [kid],
  );
  const key = result.rows[0]?.private_key;
  if (key === null || key === undefined) {
    throw new Error(`signing key ${kid} has no private material`);
  }
  return key;
}

/**
 * INV-09: revocation takes the same mandate row lock authorisation takes.
 *
 * Revokes a mandate under the same row lock authorisation takes, so the two cannot
 * interleave. Reservations still held when revocation lands are reported rather than
 * cancelled: the money may already be in flight, and it is resolved by reconciliation and
 * a compensating refund. The system never claims to have stopped something it could not.
 */
export async function revoke(
  pool: Pool,
  options: MandateServiceOptions,
  input: RevokeMandateInput,
): Promise<RevocationResult | null> {
  return withAuthorizationTransaction(pool, options, async (client) => {
    const mandate = await repo.lockForRevoke(client, input.mandate_id);
    if (mandate === null) return null;

    if (mandate.state === "revoked") {
      return {
        mandateId: mandate.mandateId,
        alreadyRevoked: true,
        heldReservationIds: [],
        ledgerSeq: null,
      };
    }

    const held = await repo.heldReservations(client, mandate.mandateId);
    await repo.markRevoked(client, mandate.mandateId);

    const entry = await append(client, {
      chainId: mandate.mandateId,
      kind: "DECISION",
      merchantId: mandate.merchantId,
      ref: mandate.mandateId,
      payloadRedacted: {
        decision_id: `dec_${randomUUID()}`,
        verdict: "DENY",
        reason_code: "MND-003",
        reason: input.reason,
        held_reservations: held,
      },
    });

    await client.query(
      `UPDATE mandates SET chain_head_seq = $2, chain_head_hash = $3 WHERE mandate_id = $1`,
      [mandate.mandateId, entry.seq, entry.hash],
    );

    return {
      mandateId: mandate.mandateId,
      alreadyRevoked: false,
      heldReservationIds: held,
      ledgerSeq: entry.seq,
    };
  });
}
