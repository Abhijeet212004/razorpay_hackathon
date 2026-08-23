import { z } from "zod";
import { PaiseSchema, paiseToCanonical } from "../../shared/money.js";
import { ReasonCodeSchema, VerdictSchema } from "../../shared/reason-codes.js";
import { EvaluatedRuleSchema } from "../policy/policy.validation.js";
import { SignedQuoteSchema } from "../quote/quote.validation.js";
import type { JsonValue } from "../../shared/crypto/jcs.js";

/**
 * What an agent proposes. Never what the kernel executes.
 *
 * `rationale` is the model's own words: display-only, tainted at the edge, and not
 * readable by any rule.
 */
export const IntentSchema = z.object({
  intent_id: z.string().min(1),
  type: z.literal("purchase"),
  mandate_id: z.string().min(1),
  quote_id: z.string().min(1),
  merchant_id: z.string().min(1),
  amount_paise: PaiseSchema,
  basket_hash: z.string().regex(/^[0-9a-f]{64}$/),
  rationale: z.string().max(2000),
  nonce: z.string().min(16).max(128),
  expires_at: z.string().datetime({ offset: true }),
});

export type Intent = z.infer<typeof IntentSchema>;

export const SignedIntentSchema = z.object({
  intent: IntentSchema,
  agent_id: z.string().min(1),
  signature: z.string().regex(/^[0-9a-f]+$/),
});

export type SignedIntent = z.infer<typeof SignedIntentSchema>;

/** The exact bytes signed and verified. Both sides import this. */
export function intentSigningPayload(intent: Intent): JsonValue {
  return {
    amount_paise: paiseToCanonical(intent.amount_paise),
    basket_hash: intent.basket_hash,
    expires_at: intent.expires_at,
    intent_id: intent.intent_id,
    mandate_id: intent.mandate_id,
    merchant_id: intent.merchant_id,
    nonce: intent.nonce,
    quote_id: intent.quote_id,
    rationale: intent.rationale,
    type: intent.type,
  };
}

export const DecisionSchema = z.object({
  decision_id: z.string().min(1),
  intent_id: z.string().min(1),
  mandate_id: z.string().min(1),
  verdict: VerdictSchema,
  reason_code: ReasonCodeSchema,
  evaluated: z.array(EvaluatedRuleSchema),

  /** Present on ALLOW and STEP_UP: the reservation written inside the lock. */
  reservation_id: z.string().min(1).nullable(),

  /** Present on ALLOW: sha256(intent_id). */
  idempotency_key: z.string().regex(/^[0-9a-f]{64}$/).nullable(),

  /** Present on STEP_UP: the single-use challenge bound to this intent. */
  challenge_id: z.string().min(1).nullable(),

  /**
   * Sequence of the DECISION entry this authorisation appended. Null when no chain was
   * reachable: an unknown mandate has none, and lock contention never opened one.
   */
  ledger_seq: z.number().int().nonnegative().nullable(),

  decided_at: z.string().datetime({ offset: true }),
});

export type Decision = z.infer<typeof DecisionSchema>;

export const AuthorizationRequestSchema = z.object({
  signedIntent: SignedIntentSchema,
  signedQuote: SignedQuoteSchema,
});

export type AuthorizationRequest = z.infer<typeof AuthorizationRequestSchema>;
