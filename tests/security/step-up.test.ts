import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approveStepUp,
  authorize,
} from "../../src/modules/authorization/authorization.service.js";
import { expireChallenges } from "../../src/modules/jobs/expire.job.js";
import { revoke } from "../../src/modules/mandate/mandate.service.js";
import { ROLES } from "../../src/shared/db/roles.js";
import { startTestDatabase, withMerchantContext, type TestDatabase } from "../support/postgres.js";
import { startTestRail, testKernel, type TestRail } from "../support/kernel.js";
import {
  MERCHANT_A,
  issueQuote,
  makeSignedIntent,
  seedAgent,
  seedCapturedReservation,
  seedMandate,
  seedMerchant,
  seedSigningKey,
  seedSubject,
  type SeededAgent,
  type SeededKey,
} from "../support/fixtures.js";

/**
 * A step-up is the one moment the design refuses to automate. Approval re-checks only
 * what a human could have outlasted — a revocation, an expiry, a reaped hold — and never
 * re-runs the sequence, because the first pass already burned the nonce and consumed the
 * quote.
 */
describe("step-up approval", () => {
  let db: TestDatabase;
  let rail: TestRail;
  let agent: SeededAgent;
  let quoteKey: SeededKey;
  let mandateKid: string;
  let pseudonym: string;
  let authEventId: string;

  const SILENT = 50_000n;
  const LOUD = 124_000n;

  const lockOptions = {
    merchantId: MERCHANT_A,
    lockTimeoutMs: 3_000,
    statementTimeoutMs: 5_000,
    retryAttempts: 3,
    retryBackoffMs: [10, 40, 160],
  };

  beforeAll(async () => {
    db = await startTestDatabase();
    await seedMerchant(db.superuser);
    mandateKid = (await seedSigningKey(db.superuser, "mandate")).kid;
    quoteKey = await seedSigningKey(db.superuser, "quote");
    agent = await seedAgent(db.superuser);
    const subject = await seedSubject(db.superuser);
    pseudonym = subject.pseudonym;
    authEventId = subject.authEventId;
    rail = await startTestRail(db.as(ROLES.kernel));
  });

  afterAll(async () => {
    await rail?.close();
    await db?.stop();
  });

  async function mandate() {
    const id = await seedMandate(db.superuser, {
      agentId: agent.agentId,
      authEventId,
      pseudonym,
      kid: mandateKid,
      silentThresholdPaise: SILENT,
      cumulativePaise: 5_000_000n,
      perTransactionPaise: 5_000_000n,
      velocityPerHour: 1_000,
    });
    await seedCapturedReservation(db.superuser, { mandateId: id, amountPaise: 1_000n, ageMs: 86_400_000 });
    return id;
  }

  async function raiseStepUp(mandateId: string) {
    const quote = await issueQuote(db.superuser, { mandateId, amountPaise: LOUD, key: quoteKey });
    const kernel = testKernel(db.as(ROLES.kernel), MERCHANT_A, { executor: rail.executor });
    const decision = await authorize(kernel, {
      signedIntent: makeSignedIntent({ agent, mandateId, quote }),
      signedQuote: quote,
    });
    return { decision, kernel };
  }

  it("raises a challenge and holds the amount, without executing", async () => {
    const mandateId = await mandate();
    const { decision } = await raiseStepUp(mandateId);

    expect(decision.verdict).toBe("STEP_UP");
    expect(decision.reason_code).toBe("STP-001");
    expect(decision.challenge_id).toMatch(/^chl_/);

    const state = await withMerchantContext(db.as(ROLES.kernel), MERCHANT_A, async (client) => {
      const r = await client.query<{ state: string; step_up: boolean }>(
        `SELECT state, step_up FROM reservations WHERE intent_id = $1`, [decision.intent_id]);
      const o = await client.query(`SELECT 1 FROM orders WHERE intent_id = $1`, [decision.intent_id]);
      return { reservation: r.rows[0], orders: o.rowCount };
    });

    // The hold exists so a burst of approvals cannot arrive against a cap that never saw
    // them coming. Nothing has been executed: a human still has to act.
    expect(state.reservation).toMatchObject({ state: "held", step_up: true });
    expect(state.orders).toBe(0);
  });

  it("executes on approval, without re-running the sequence", async () => {
    const mandateId = await mandate();
    const { decision, kernel } = await raiseStepUp(mandateId);

    const approved = await approveStepUp(kernel, decision.challenge_id!);
    expect(approved.verdict).toBe("ALLOW");
    expect(approved.reason_code).toBe("OK-000");
    expect(approved.intent_id).toBe(decision.intent_id);

    const after = await withMerchantContext(db.as(ROLES.kernel), MERCHANT_A, async (client) => {
      const orders = await client.query<{ state: string }>(
        `SELECT state FROM orders WHERE intent_id = $1`, [decision.intent_id]);
      const nonces = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM intent_nonces WHERE intent_id = $1`,
        [decision.intent_id]);
      const quotes = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM quotes
          WHERE mandate_id = $1 AND consumed_by = $2`, [mandateId, decision.intent_id]);
      return {
        order: orders.rows[0]?.state,
        nonces: Number(nonces.rows[0]!.count),
        quotes: Number(quotes.rows[0]!.count),
      };
    });

    expect(after.order).toBeDefined();
    // Exactly one nonce and one consumed quote: approval did not burn a second of either,
    // which is what re-entering the sequence would have done.
    expect(after.nonces).toBe(1);
    expect(after.quotes).toBe(1);
  });

  it("is single use", async () => {
    const mandateId = await mandate();
    const { decision, kernel } = await raiseStepUp(mandateId);

    await approveStepUp(kernel, decision.challenge_id!);
    const again = await approveStepUp(kernel, decision.challenge_id!);

    expect(again.verdict).toBe("DENY");
    expect(again.reason_code).toBe("INT-002");
  });

  it("refuses when the mandate was revoked while the human was deciding", async () => {
    const mandateId = await mandate();
    const { decision, kernel } = await raiseStepUp(mandateId);

    await revoke(db.as(ROLES.kernel), lockOptions, { mandate_id: mandateId, reason: "changed my mind" });

    const approved = await approveStepUp(kernel, decision.challenge_id!);
    expect(approved.verdict).toBe("DENY");
    expect(approved.reason_code).toBe("MND-003");
  });

  it("refuses when the hold was released while the human was deciding", async () => {
    const mandateId = await mandate();
    const { decision, kernel } = await raiseStepUp(mandateId);

    // The challenge expired and the worker released the hold.
    await db.superuser.query(
      `UPDATE challenges SET expires_at = now() - interval '1 minute' WHERE challenge_id = $1`,
      [decision.challenge_id],
    );
    await expireChallenges(db.as(ROLES.kernel), MERCHANT_A);

    const approved = await approveStepUp(kernel, decision.challenge_id!);
    // Authorising now would spend against a cap that no longer counts the amount.
    expect(approved.verdict).toBe("DENY");
    expect(approved.reason_code).toBe("INT-002");
  });

  it("releases the hold when the user rejects", async () => {
    const mandateId = await mandate();
    const { decision, kernel } = await raiseStepUp(mandateId);

    const rejected = await approveStepUp(kernel, decision.challenge_id!, false);
    expect(rejected.verdict).toBe("DENY");

    const reservation = await withMerchantContext(db.as(ROLES.kernel), MERCHANT_A, async (client) => {
      const r = await client.query<{ state: string; release_reason: string | null }>(
        `SELECT state, release_reason FROM reservations WHERE intent_id = $1`,
        [decision.intent_id]);
      return r.rows[0];
    });
    expect(reservation).toMatchObject({ state: "released", release_reason: "step_up_abandoned" });
  });
});
