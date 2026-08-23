import type { Paise } from "../../shared/money.js";
import type { Intent } from "../authorization/authorization.validation.js";

/**
 * The verifier may only subtract permission. There is no ALLOW in this union, so
 * granting is unrepresentable rather than merely discouraged.
 *
 * PROCEED means "no objection" — it still faces every check from the mandate lock on.
 */
export type VerifierOutcome =
  | { readonly kind: "PROCEED" }
  | { readonly kind: "DENY"; readonly detail: string }
  | { readonly kind: "UNAVAILABLE"; readonly detail: string };

export interface VerifierInput {
  /** The intent only. The verifier never sees catalog text. */
  readonly intent: Intent;
  readonly amountPaise: Paise;
  readonly merchantId: string;
}

export interface BlindVerifier {
  assess(input: VerifierInput): Promise<VerifierOutcome>;
}

export type VerifierMode = "scripted" | "claude" | "off";
