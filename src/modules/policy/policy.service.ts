import { paiseToCanonical } from "../../shared/money.js";
import { VERDICT_FOR_REASON, type ReasonCode } from "../../shared/reason-codes.js";
import type { EvaluatedRule, PolicyFacts, PolicyOutcome } from "./policy.validation.js";

/**
 * A pure fold over values already read under the mandate row lock. This module opens no
 * transaction, issues no query and makes no network call, which is what keeps a stale cap
 * read or an under-lock egress from being possible here at all.
 *
 * INV-08: fail closed — the fold's default arm denies, so an unrecognised state can
 * never fall through to ALLOW.
 *
 * Deterministic, first failure wins. Order is the specification: a request that breaks
 * several rules is reported against the first one, and the trace shows every rule reached
 * with the observed value beside the bound it was checked against.
 */

interface Check {
  rule: string;
  passed: boolean;
  observed: string | null;
  bound: string | null;
  reasonCode: ReasonCode;
}

function fold(checks: readonly Check[]): PolicyOutcome {
  const evaluated: EvaluatedRule[] = [];

  for (const check of checks) {
    evaluated.push({
      rule: check.rule,
      passed: check.passed,
      observed: check.observed,
      bound: check.bound,
      reason_code: check.passed ? null : check.reasonCode,
    });

    if (!check.passed) {
      return {
        verdict: VERDICT_FOR_REASON[check.reasonCode],
        reasonCode: check.reasonCode,
        evaluated,
      };
    }
  }

  return { verdict: "ALLOW", reasonCode: "OK-000", evaluated };
}

function isSubset(values: readonly string[], allowed: readonly string[]): boolean {
  return values.every((value) => allowed.includes(value));
}

export function evaluate(facts: PolicyFacts): PolicyOutcome {
  const { mandate, intent, quote } = facts;
  const cumulativeAfter = facts.reservedAndCapturedPaise + intent.amountPaise;

  const checks: Check[] = [
    // Computed before the transaction opened, checked first so a forged request is
    // reported as forged rather than as whichever limit it also happened to break.
    {
      rule: "stateless",
      passed: facts.statelessFailure === null,
      observed: facts.statelessFailure,
      bound: null,
      reasonCode: facts.statelessFailure ?? "INT-001",
    },
    {
      rule: "taint.decisionField",
      passed: !intent.taintReachedDecisionField,
      observed: String(intent.taintReachedDecisionField),
      bound: "false",
      reasonCode: "SEC-001",
    },
    {
      rule: "agent.registered",
      passed: facts.agentRegistered,
      observed: intent.agentId,
      bound: "registered",
      reasonCode: "SEC-002",
    },

    // The verifier can only subtract. PROCEED is not a grant, and UNAVAILABLE denies
    // above the silent threshold rather than falling through.
    {
      rule: "verifier.objection",
      passed: facts.verifier.kind !== "DENY",
      observed: facts.verifier.kind,
      bound: "no objection",
      reasonCode: "SEC-004",
    },
    {
      rule: "verifier.availability",
      passed:
        facts.verifier.kind !== "UNAVAILABLE" ||
        intent.amountPaise <= mandate.silentThresholdPaise,
      observed: facts.verifier.kind,
      bound: paiseToCanonical(mandate.silentThresholdPaise),
      reasonCode: "SYS-002",
    },

    {
      rule: "mandate.bindsAgent",
      passed: mandate.agentId === intent.agentId,
      observed: intent.agentId,
      bound: mandate.agentId,
      reasonCode: "MND-001",
    },
    {
      rule: "mandate.authEvent",
      passed: mandate.hasAuthEvent,
      observed: String(mandate.hasAuthEvent),
      bound: "true",
      reasonCode: "AUT-001",
    },
    // INV-03: no debit without a valid, unexpired, unrevoked mandate.
    {
      rule: "mandate.notRevoked",
      passed: mandate.state !== "revoked",
      observed: mandate.state,
      bound: "live",
      reasonCode: "MND-003",
    },
    {
      rule: "mandate.validity",
      passed:
        mandate.state === "live" &&
        facts.now >= mandate.notBefore &&
        facts.now < mandate.notAfter,
      observed: facts.now.toISOString(),
      bound: mandate.notAfter.toISOString(),
      reasonCode: "MND-002",
    },

    {
      rule: "scope.merchant",
      passed: mandate.allowedMerchants.includes(intent.merchantId),
      observed: intent.merchantId,
      bound: mandate.allowedMerchants.join(","),
      reasonCode: "SCP-001",
    },
    {
      rule: "scope.category",
      passed: isSubset(quote.categories, mandate.allowedCategories),
      observed: quote.categories.join(","),
      bound: mandate.allowedCategories.join(","),
      reasonCode: "SCP-002",
    },

    {
      rule: "intent.nonceUnspent",
      passed: !facts.nonceAlreadySpent,
      observed: String(facts.nonceAlreadySpent),
      bound: "false",
      reasonCode: "INT-002",
    },
    {
      rule: "quote.unconsumed",
      passed: !facts.quoteAlreadyConsumed,
      observed: String(facts.quoteAlreadyConsumed),
      bound: "false",
      reasonCode: "INT-002",
    },
    {
      rule: "quote.notExpired",
      passed: facts.now < quote.expiresAt,
      observed: facts.now.toISOString(),
      bound: quote.expiresAt.toISOString(),
      reasonCode: "INT-002",
    },

    {
      rule: "limits.perTransaction",
      passed: intent.amountPaise <= mandate.perTransactionPaise,
      observed: paiseToCanonical(intent.amountPaise),
      bound: paiseToCanonical(mandate.perTransactionPaise),
      reasonCode: "LMT-001",
    },
    {
      rule: "limits.cumulative",
      passed: cumulativeAfter <= mandate.cumulativePaise,
      observed: paiseToCanonical(cumulativeAfter),
      bound: paiseToCanonical(mandate.cumulativePaise),
      reasonCode: "LMT-002",
    },
    {
      rule: "limits.velocity",
      passed: facts.reservationsLastHour < mandate.velocityPerHour,
      observed: String(facts.reservationsLastHour),
      bound: String(mandate.velocityPerHour),
      reasonCode: "LMT-003",
    },

    // Step-up rules come last: an amount that also breaks a cap is denied, not escalated
    // to a human who would be asked to approve something the mandate forbids.
    {
      rule: "stepUp.silentThreshold",
      passed: intent.amountPaise <= mandate.silentThresholdPaise,
      observed: paiseToCanonical(intent.amountPaise),
      bound: paiseToCanonical(mandate.silentThresholdPaise),
      reasonCode: "STP-001",
    },
    {
      rule: "stepUp.firstAtMerchant",
      passed: facts.seenThisMerchantBefore,
      observed: String(facts.seenThisMerchantBefore),
      bound: "true",
      reasonCode: "STP-002",
    },
  ];

  return fold(checks);
}
