import { z } from "zod";
import type { Paise } from "../../shared/money.js";
import { ReasonCodeSchema, type ReasonCode, type Verdict } from "../../shared/reason-codes.js";
import type { VerifierOutcome } from "../verifier/verifier.validation.js";

/** One evaluated rule, with the observed value beside the bound it was checked against. */
export const EvaluatedRuleSchema = z.object({
  rule: z.string().min(1),
  passed: z.boolean(),
  observed: z.string().nullable(),
  bound: z.string().nullable(),
  reason_code: ReasonCodeSchema.nullable(),
});

export type EvaluatedRule = z.infer<typeof EvaluatedRuleSchema>;

/** Everything the fold may see. Read under the mandate row lock by the caller. */
export interface PolicyFacts {
  readonly now: Date;

  /**
   * The reason code from stateless validation, computed before the transaction opened.
   * Passed in as a fact so the fold produces one ordered trace covering every check
   * rather than the caller short-circuiting and skipping the ledger entry.
   */
  readonly statelessFailure: ReasonCode | null;

  /** Computed outside the transaction. Can only subtract permission. */
  readonly verifier: VerifierOutcome;

  readonly mandate: {
    readonly mandateId: string;
    readonly merchantId: string;
    readonly agentId: string;
    readonly state: "live" | "revoked" | "expired";
    readonly notBefore: Date;
    readonly notAfter: Date;
    readonly perTransactionPaise: Paise;
    readonly cumulativePaise: Paise;
    readonly velocityPerHour: number;
    readonly silentThresholdPaise: Paise;
    readonly allowedMerchants: readonly string[];
    readonly allowedCategories: readonly string[];
    readonly hasAuthEvent: boolean;
  };

  readonly intent: {
    readonly intentId: string;
    readonly merchantId: string;
    readonly amountPaise: Paise;
    readonly agentId: string;
    readonly taintReachedDecisionField: boolean;
  };

  readonly quote: {
    readonly quoteId: string;
    readonly mandateId: string;
    readonly amountPaise: Paise;
    readonly categories: readonly string[];
    readonly expiresAt: Date;
  };

  /** True when the nonce was already spent, discovered by the burn colliding. */
  readonly nonceAlreadySpent: boolean;

  /** True when this quote was already consumed by an earlier intent. */
  readonly quoteAlreadyConsumed: boolean;

  /** Sum of reservations in ('held','captured') within the window, read under the lock. */
  readonly reservedAndCapturedPaise: Paise;

  /** Reservations in ('held','captured') created in the last hour. */
  readonly reservationsLastHour: number;

  /** True once this mandate has a captured reservation at this merchant. */
  readonly seenThisMerchantBefore: boolean;

  readonly agentRegistered: boolean;
}

export interface PolicyOutcome {
  readonly verdict: Verdict;
  readonly reasonCode: ReasonCode;
  readonly evaluated: readonly EvaluatedRule[];
}
