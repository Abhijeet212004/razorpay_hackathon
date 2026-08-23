import type { JsonValue } from "../../shared/crypto/jcs.js";

export const LEDGER_KINDS = [
  "MANDATE_ISSUED", "INTENT", "DECISION", "RESERVATION", "API_CALL", "WEBHOOK",
  "EXECUTION_RESULT", "RELEASE", "RECONCILE", "REFUND", "ANCHOR",
] as const;

export type LedgerKind = (typeof LEDGER_KINDS)[number];

export interface LedgerAppend {
  readonly chainId: string;
  readonly kind: LedgerKind;
  readonly merchantId: string;
  readonly ref: string | null;
  readonly payloadRedacted: JsonValue;
}

export interface LedgerEntry {
  readonly chainId: string;
  readonly seq: number;
  readonly prevHash: Buffer;
  readonly hash: Buffer;
  readonly kind: LedgerKind;
}
