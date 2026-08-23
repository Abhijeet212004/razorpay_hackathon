import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Clock } from "../../shared/clock.js";
import { errorClass, silentLogger, type Logger } from "../../shared/logger.js";
import type { JsonValue } from "../../shared/crypto/jcs.js";
import { withMandateLockHeld } from "../../shared/egress-guard.js";
import { LockContentionError, withAuthorizationTransaction } from "../../shared/db/transaction.js";
import { idempotencyKey } from "../../shared/crypto/hash.js";
import { paiseToCanonical } from "../../shared/money.js";
import type { ReasonCode } from "../../shared/reason-codes.js";
import { append } from "../ledger/ledger.service.js";
import { appendOperationsEvent } from "../ledger/ledger.operations.js";
import { evaluate } from "../policy/policy.service.js";
import type { PolicyFacts } from "../policy/policy.validation.js";
import type { ExecutorClient } from "../executor/executor.validation.js";
import * as identity from "../identity/identity.repository.js";
import * as quotes from "../quote/quote.repository.js";
import type { BlindVerifier, VerifierOutcome } from "../verifier/verifier.validation.js";
import * as repo from "./authorization.repository.js";
import { runStatelessChecks } from "./authorization.stateless.js";
import type { AuthorizationRequest, Decision } from "./authorization.validation.js";

/**
 * INV-01: no model output is ever executed. This function takes an intent and a quote,
 * and nothing a model produced can reach a rule — the verifier is a separate stage that
 * can only subtract.
 *
 * The authorisation sequence. This module owns the transaction.
 *
 *   1  stateless checks   signature, nonce format, expiry, taint, quote signature,
 *                         quote.mandate_id == intent.mandate_id, amount == quote.amount
 *   2  blind verifier     outside any transaction, downgrade-only, memoised per request
 *   -- BEGIN READ COMMITTED
 *   3  SELECT ... FROM mandates WHERE id = ? FOR UPDATE
 *   4  mandate live, unrevoked, scope, category
 *   5  burn the nonce
 *   6  cap read           SUM over reservations in ('held','captured') in the window
 *   7  caps               per-transaction, cumulative, spend velocity
 *   8  step-up triggers
 *   9  consume the quote
 *  10  insert reservation ('held') and the ledger INTENT, DECISION, RESERVATION entries
 *   -- COMMIT
 *  11  executor call, after commit, never during
 *
 * Steps 1 and 2 are outside the transaction because they touch no shared state and
 * because a third-party call must never run under a row lock. Step 11 is outside because
 * the reservation must be durably committed before money can move: reserving then paying
 * can over-count, which is conservative, while paying then reserving under-counts, which
 * is a cap bypass.
 *
 * Stateless failures are computed outside but recorded inside, so every decision writes
 * exactly one ledger entry on the mandate's chain.
 */

export interface KernelConfig {
  /** Set from deployment config, never from the request. Scopes every query by merchant. */
  readonly merchantId: string;

  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly retryAttempts: number;
  readonly retryBackoffMs: readonly number[];

  readonly reservationTtlMs: number;
  readonly quoteTtlMs: number;
  readonly challengeTtlMs: number;

  readonly verifierTimeoutMs: number;

  /**
   * Fail closed in production, fail loud everywhere else. Swallowing an unexpected error
   * as a denial is correct for a live system and terrible for finding bugs, so outside
   * production the error is re-thrown and crashes the run instead.
   */
  readonly rethrowUnexpectedErrors: boolean;
}

export const DEFAULT_KERNEL_CONFIG: Omit<KernelConfig, "merchantId"> = {
  lockTimeoutMs: 3_000,
  statementTimeoutMs: 5_000,
  retryAttempts: 3,
  retryBackoffMs: [10, 40, 160],
  reservationTtlMs: 15 * 60_000,
  quoteTtlMs: 10 * 60_000,
  challengeTtlMs: 5 * 60_000,
  verifierTimeoutMs: 1_500,
  rethrowUnexpectedErrors: process.env.NODE_ENV !== "production",
};

export interface KernelContext {
  /** Connected as agentkit_kernel. Never a superuser: row level security must apply. */
  readonly pool: Pool;
  readonly verifier: BlindVerifier;
  readonly clock: Clock;
  readonly config: KernelConfig;
  readonly logger?: Logger;
  /**
   * Called after COMMIT on an ALLOW, never during. In deployment this is an HTTP call to
   * a service with no public ingress holding the only payment credential; the kernel
   * expresses what should happen without being able to do it itself.
   */
  readonly executor?: ExecutorClient;
}

/**
 * A decision with no mandate chain to live on: the mandate is unknown, or its row lock
 * could not be taken. It is recorded on the merchant's operations chain instead, so every
 * decision still writes exactly one ledger entry.
 */
async function operationsDecision(
  ctx: KernelContext,
  request: AuthorizationRequest,
  reasonCode: ReasonCode,
  now: Date,
  detail: JsonValue = null,
): Promise<Decision> {
  const intent = request.signedIntent.intent;

  let ledgerSeq: number | null = null;
  try {
    const entry = await appendOperationsEvent(
      ctx.pool,
      {
        merchantId: ctx.config.merchantId,
        lockTimeoutMs: ctx.config.lockTimeoutMs,
        statementTimeoutMs: ctx.config.statementTimeoutMs,
        retryAttempts: ctx.config.retryAttempts,
        retryBackoffMs: ctx.config.retryBackoffMs,
      },
      {
        kind: "DECISION",
        reasonCode,
        intentId: intent.intent_id,
        mandateId: intent.mandate_id,
        detail,
      },
    );
    ledgerSeq = entry?.seq ?? null;
  } catch (error) {
    // The operations chain is the last place a denial can be recorded. If it is also
    // unreachable the denial still stands: a decision is never upgraded by a logging
    // failure.
    ctx.logger?.error("operations chain append failed", error);
  }

  return {
    decision_id: `dec_${randomUUID()}`,
    intent_id: intent.intent_id,
    mandate_id: intent.mandate_id,
    verdict: "DENY",
    reason_code: reasonCode,
    evaluated: [],
    reservation_id: null,
    idempotency_key: null,
    challenge_id: null,
    ledger_seq: ledgerSeq,
    decided_at: now.toISOString(),
  };
}

/**
 * Runs the blind verifier with a timeout. It can only downgrade: an objection denies, a
 * timeout above the silent threshold denies, and a timeout below it proceeds with the
 * skip recorded. Nothing it returns can grant.
 */
async function runVerifier(
  ctx: KernelContext,
  request: AuthorizationRequest,
): Promise<VerifierOutcome> {
  const intent = request.signedIntent.intent;
  try {
    return await Promise.race([
      ctx.verifier.assess({
        intent,
        amountPaise: intent.amount_paise,
        merchantId: intent.merchant_id,
      }),
      new Promise<VerifierOutcome>((resolve) =>
        setTimeout(
          () => resolve({ kind: "UNAVAILABLE", detail: "verifier timed out" }),
          ctx.config.verifierTimeoutMs,
        ),
      ),
    ]);
  } catch (error) {
    return { kind: "UNAVAILABLE", detail: String(error) };
  }
}

/**
 * Hands the committed decision to the executor. A failure here never changes the verdict:
 * the authorisation stood, and an unexecuted reservation is reaped later rather than
 * being retried blindly into a possible double charge.
 */
async function settle(
  ctx: KernelContext,
  decision: Decision,
  amountPaise: bigint,
): Promise<void> {
  if (ctx.executor === undefined) return;

  try {
    await ctx.executor.execute({
      intentId: decision.intent_id,
      mandateId: decision.mandate_id,
      merchantId: ctx.config.merchantId,
      amountPaise,
      decisionId: decision.decision_id,
    });
  } catch (error) {
    (ctx.logger ?? silentLogger).error("executor call failed after commit", error);
    (ctx.logger ?? silentLogger).count("authorize.settle.failed");
  }
}

export class UnknownMandateError extends Error {
  constructor(readonly mandateId: string) {
    super(`no mandate ${mandateId} is visible to this merchant`);
    this.name = "UnknownMandateError";
  }
}

export async function authorize(
  ctx: KernelContext,
  request: AuthorizationRequest,
): Promise<Decision> {
  const now = ctx.clock.now();

  try {
    // Step 1. Public keys are read without a lock so signature checking never contends
    // for the mandate row.
    const [agent, quoteKey] = await Promise.all([
      identity.findAgent(ctx.pool, request.signedIntent.agent_id),
      identity.findVerificationKey(ctx.pool, request.signedQuote.kid),
    ]);

    const statelessFailure = runStatelessChecks(
      request,
      {
        agentPublicKey: agent?.publicKey ?? null,
        quotePublicKey: quoteKey?.publicKey ?? null,
      },
      now,
    );

    // Step 2, outside any transaction. Computed once, here, so a lock retry never
    // re-runs it. Skipped when the request has already failed: there is nothing for a
    // downgrade-only stage to add to a denial.
    const verifier: VerifierOutcome =
      statelessFailure === null
        ? await runVerifier(ctx, request)
        : { kind: "PROCEED" };

    const decision = await withAuthorizationTransaction(
      ctx.pool,
      {
        merchantId: ctx.config.merchantId,
        lockTimeoutMs: ctx.config.lockTimeoutMs,
        statementTimeoutMs: ctx.config.statementTimeoutMs,
        retryAttempts: ctx.config.retryAttempts,
        retryBackoffMs: ctx.config.retryBackoffMs,
      },
      (client) => runLocked(ctx, request, statelessFailure, verifier, now, client),
    );

    // Step 13. After the reservation is durable, and outside every lock.
    if (decision.verdict === "ALLOW") {
      await settle(ctx, decision, request.signedIntent.intent.amount_paise);
    }

    return decision;
  } catch (error) {
    const logger = ctx.logger ?? silentLogger;

    if (error instanceof UnknownMandateError) {
      logger.count("authorize.deny.mnd_001");
      return operationsDecision(ctx, request, "MND-001", now, {
        mandate_id: error.mandateId,
      });
    }

    if (error instanceof LockContentionError) {
      logger.count("authorize.deny.sys_003");
      return operationsDecision(ctx, request, "SYS-003", now, {
        attempts: ctx.config.retryAttempts,
      });
    }

    // Fail closed: an error that reaches a caller is an error a caller might treat as a
    // pass. Fail loud too — outside production this re-throws, so a bug crashes the run
    // instead of quietly denying.
    logger.error("unexpected error in authorize", error);
    logger.count("authorize.deny.sys_001.unexpected");

    if (ctx.config.rethrowUnexpectedErrors) throw error;

    // The class, never the message: the ledger is append-only and messages carry PII.
    return operationsDecision(ctx, request, "SYS-001", now, {
      error_class: errorClass(error),
    });
  }
}

async function runLocked(
  ctx: KernelContext,
  request: AuthorizationRequest,
  statelessFailure: ReasonCode | null,
  verifier: VerifierOutcome,
  now: Date,
  client: PoolClient,
): Promise<Decision> {
  const intent = request.signedIntent.intent;

  const mandate = await repo.lockMandate(client, intent.mandate_id);
  if (mandate === null) {
    // No mandate row, so no mandate chain. Recorded on the merchant's operations chain
    // by the caller, which cannot append from inside this transaction without taking a
    // second lock in the opposite order.
    throw new UnknownMandateError(intent.mandate_id);
  }

  // Everything from here to COMMIT runs with egress blocked.
  return withMandateLockHeld(mandate.mandateId, async () => {
    const nonceBurned = await repo.burnNonce(client, {
      nonce: intent.nonce,
      mandateId: intent.mandate_id,
      intentId: intent.intent_id,
    });

    const quote = await quotes.findById(client, intent.quote_id);

    const [reservedAndCaptured, reservationsLastHour, seenBefore, agentRegistered] =
      await Promise.all([
        repo.sumReservedAndCaptured(client, mandate.mandateId, mandate.cumulativeWindow),
        repo.countReservationsLastHour(client, mandate.mandateId),
        repo.hasCapturedAtMerchant(client, mandate.mandateId, intent.merchant_id),
        repo.isAgentRegistered(client, request.signedIntent.agent_id),
      ]);

    const facts: PolicyFacts = {
      now,
      statelessFailure,
      verifier,
      mandate: {
        mandateId: mandate.mandateId,
        merchantId: mandate.merchantId,
        agentId: mandate.agentId,
        state: mandate.state,
        notBefore: mandate.notBefore,
        notAfter: mandate.notAfter,
        perTransactionPaise: mandate.perTransactionPaise,
        cumulativePaise: mandate.cumulativePaise,
        velocityPerHour: mandate.velocityPerHour,
        silentThresholdPaise: mandate.silentThresholdPaise,
        allowedMerchants: mandate.allowedMerchants,
        allowedCategories: mandate.allowedCategories,
        hasAuthEvent: mandate.authEventId !== null,
      },
      intent: {
        intentId: intent.intent_id,
        merchantId: intent.merchant_id,
        amountPaise: intent.amount_paise,
        agentId: request.signedIntent.agent_id,
        taintReachedDecisionField: false,
      },
      quote: {
        quoteId: quote?.quoteId ?? intent.quote_id,
        mandateId: quote?.mandateId ?? "",
        amountPaise: quote?.amountPaise ?? 0n,
        // Categories come from the stored quote, not the presented one: the server
        // derived them from its own catalog when it priced the basket.
        categories: quote?.categories ?? [],
        expiresAt: quote?.expiresAt ?? new Date(0),
      },
      nonceAlreadySpent: !nonceBurned,
      quoteAlreadyConsumed: quote?.consumedAt !== null && quote?.consumedAt !== undefined,
      reservedAndCapturedPaise: reservedAndCaptured,
      reservationsLastHour,
      seenThisMerchantBefore: seenBefore,
      agentRegistered,
    };

    const outcome = evaluate(facts);

    let reservationId: string | null = null;

    if (outcome.verdict === "ALLOW" || outcome.verdict === "STEP_UP") {
      const consumed = await quotes.consume(client, intent.quote_id, intent.intent_id);
      if (!consumed) {
        // Unreachable while the mandate lock is held, since only an authoriser for this
        // mandate can consume this quote. Reaching it means the lock was not taken.
        throw new Error(
          `quote ${intent.quote_id} was consumed concurrently while the mandate row lock was held`,
        );
      }

      reservationId = await repo.insertReservation(client, {
        mandateId: mandate.mandateId,
        merchantId: intent.merchant_id,
        intentId: intent.intent_id,
        amountPaise: intent.amount_paise,
        stepUp: outcome.verdict === "STEP_UP",
      });
    }

    const decisionId = `dec_${randomUUID()}`;

    await append(client, {
      chainId: mandate.mandateId,
      kind: "INTENT",
      merchantId: mandate.merchantId,
      ref: intent.intent_id,
      payloadRedacted: {
        intent_id: intent.intent_id,
        quote_id: intent.quote_id,
        merchant_id: intent.merchant_id,
        amount_paise: paiseToCanonical(intent.amount_paise),
        agent_id: request.signedIntent.agent_id,
      },
    });

    // INV-10: exactly one DECISION entry per decision, whatever the verdict.
    const decisionEntry = await append(client, {
      chainId: mandate.mandateId,
      kind: "DECISION",
      merchantId: mandate.merchantId,
      ref: intent.intent_id,
      payloadRedacted: {
        decision_id: decisionId,
        intent_id: intent.intent_id,
        verdict: outcome.verdict,
        reason_code: outcome.reasonCode,
        evaluated: outcome.evaluated.map((rule) => ({
          rule: rule.rule,
          passed: rule.passed,
          observed: rule.observed,
          bound: rule.bound,
          reason_code: rule.reason_code,
        })),
      },
    });

    let head = decisionEntry;

    if (reservationId !== null) {
      head = await append(client, {
        chainId: mandate.mandateId,
        kind: "RESERVATION",
        merchantId: mandate.merchantId,
        ref: intent.intent_id,
        payloadRedacted: {
          reservation_id: reservationId,
          intent_id: intent.intent_id,
          amount_paise: paiseToCanonical(intent.amount_paise),
          state: "held",
          step_up: outcome.verdict === "STEP_UP",
        },
      });
    }

    await repo.updateChainHead(client, mandate.mandateId, head.seq, head.hash);

    return {
      decision_id: decisionId,
      intent_id: intent.intent_id,
      mandate_id: mandate.mandateId,
      verdict: outcome.verdict,
      reason_code: outcome.reasonCode,
      evaluated: [...outcome.evaluated],
      reservation_id: reservationId,
      idempotency_key:
        outcome.verdict === "ALLOW" ? idempotencyKey(intent.intent_id) : null,
      challenge_id: null,
      ledger_seq: decisionEntry.seq,
      decided_at: now.toISOString(),
    };
  });
}
