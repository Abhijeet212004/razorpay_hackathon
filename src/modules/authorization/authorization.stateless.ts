import { verifyPayload } from "../../shared/crypto/ed25519.js";
import type { ReasonCode } from "../../shared/reason-codes.js";
import { quoteSigningPayload } from "../quote/quote.validation.js";
import { intentSigningPayload, type AuthorizationRequest } from "./authorization.validation.js";

/**
 * Checks that depend only on the request and on public keys. They run before BEGIN
 * because they touch no shared state, and because rejecting a forged signature should
 * never contend for the mandate row lock.
 *
 * Returns the first failing reason code, or null. The result is passed into the policy
 * fold rather than short-circuiting the caller, so the denial still reaches the ledger.
 */

export interface StatelessKeys {
  /** Null when no agent is registered under the id the intent claims. */
  readonly agentPublicKey: Buffer | null;
  /** Null when the quote names a kid we have never issued. */
  readonly quotePublicKey: Buffer | null;
}

export function runStatelessChecks(
  request: AuthorizationRequest,
  keys: StatelessKeys,
  now: Date,
): ReasonCode | null {
  const { signedIntent, signedQuote } = request;
  const intent = signedIntent.intent;
  const quote = signedQuote.quote;

  if (keys.agentPublicKey === null) return "SEC-002";

  const intentSignatureValid = verifyPayload(
    keys.agentPublicKey,
    intentSigningPayload(intent),
    Buffer.from(signedIntent.signature, "hex"),
  );
  if (!intentSignatureValid) return "INT-001";

  if (keys.quotePublicKey === null) return "INT-001";

  const quoteSignatureValid = verifyPayload(
    keys.quotePublicKey,
    quoteSigningPayload(quote),
    Buffer.from(signedQuote.signature, "hex"),
  );
  if (!quoteSignatureValid) return "INT-001";

  if (new Date(intent.expires_at) <= now) return "INT-002";
  if (new Date(quote.expires_at) <= now) return "INT-002";

  // A quote that does not name this mandate is a transferable credential for a price.
  if (quote.mandate_id !== intent.mandate_id) return "INT-004";

  // INV-06: zero tolerance — the executed amount is the signed quote amount.
  if (intent.amount_paise !== quote.amount_paise) return "INT-003";
  if (intent.basket_hash !== quote.basket_hash) return "INT-003";
  if (intent.quote_id !== quote.quote_id) return "INT-004";

  return null;
}
