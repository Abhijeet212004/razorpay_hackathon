import type { Pool } from "pg";
import { withAuthorizationTransaction } from "../../shared/db/transaction.js";
import type { JsonValue } from "../../shared/crypto/jcs.js";
import type { ReasonCode } from "../../shared/reason-codes.js";
import { append } from "./ledger.service.js";
import { lockMerchant, updateMerchantChainHead } from "./ledger.repository.js";
import type { LedgerEntry } from "./ledger.validation.js";

/**
 * The operations chain: chain_id = merchant_id.
 *
 * It carries every decision that has no mandate chain to live on — an unknown mandate,
 * an exhausted lock, a rate limit tripped before any mandate was resolved, a breaker
 * trip, and operator impersonation. Without it those decisions would go unrecorded, and
 * "every decision writes exactly one ledger entry" would be true only of the easy cases.
 *
 * Appends serialise on the merchant row rather than a mandate row.
 */

export interface OperationsChainOptions {
  readonly merchantId: string;
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly retryAttempts: number;
  readonly retryBackoffMs: readonly number[];
}

export type OperationsEvent =
  | {
      readonly kind: "DECISION";
      readonly reasonCode: ReasonCode;
      readonly intentId: string | null;
      readonly mandateId: string | null;
      readonly detail: JsonValue;
    }
  | {
      readonly kind: "IMPERSONATION";
      readonly operator: string;
      readonly reason: string;
    };

function payloadFor(event: OperationsEvent): JsonValue {
  if (event.kind === "IMPERSONATION") {
    // The merchant sees this in their own console. That is the point: the party
    // operating the guard layer cannot look without leaving a record the merchant reads.
    return {
      event: "operator_impersonation",
      operator: event.operator,
      reason: event.reason,
    };
  }
  return {
    event: "decision",
    reason_code: event.reasonCode,
    intent_id: event.intentId,
    mandate_id: event.mandateId,
    detail: event.detail,
  };
}

/** Appends to the operations chain in its own transaction, under the merchant row lock. */
export async function appendOperationsEvent(
  pool: Pool,
  options: OperationsChainOptions,
  event: OperationsEvent,
): Promise<LedgerEntry | null> {
  return withAuthorizationTransaction(pool, options, async (client) => {
    const merchant = await lockMerchant(client, options.merchantId);
    if (merchant === null) return null;

    const entry = await append(client, {
      chainId: options.merchantId,
      kind: event.kind === "IMPERSONATION" ? "API_CALL" : "DECISION",
      merchantId: options.merchantId,
      ref: event.kind === "DECISION" ? event.intentId : null,
      payloadRedacted: payloadFor(event),
    });

    await updateMerchantChainHead(client, options.merchantId, entry.seq, entry.hash);
    return entry;
  });
}
