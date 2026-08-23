/** INV-09, INV-11, INV-20 — the jobs that resolve every non-terminal state. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authorize } from "../../src/modules/authorization/authorization.service.js";
import { revoke } from "../../src/modules/mandate/mandate.service.js";
import { compensateRevoked } from "../../src/modules/jobs/compensate-revoked.job.js";
import { expireChallenges, expireMandates } from "../../src/modules/jobs/expire.job.js";
import { verifyAndAnchor } from "../../src/modules/jobs/verify-anchor.job.js";
import { ingestWebhook } from "../../src/modules/reconciler/reconciler.service.js";
import { createHttpRail } from "../../src/modules/rail/rail.http.js";
import { ROLES } from "../../src/shared/db/roles.js";
import { startTestDatabase, withMerchantContext, type TestDatabase } from "../support/postgres.js";
import { TEST_WEBHOOK_SECRET, startTestRail, testKernel, type TestRail } from "../support/kernel.js";
import { createHmac } from "node:crypto";
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

const LOCK_OPTIONS = {
  merchantId: MERCHANT_A,
  lockTimeoutMs: 3_000,
  statementTimeoutMs: 5_000,
  retryAttempts: 3,
  retryBackoffMs: [10, 40, 160],
};

describe("worker jobs", () => {
  let db: TestDatabase;
  let rail: TestRail;
  let agent: SeededAgent;
  let quoteKey: SeededKey;

  beforeAll(async () => {
    db = await startTestDatabase();
    await seedMerchant(db.superuser);
    await seedSigningKey(db.superuser, "anchor");
    quoteKey = await seedSigningKey(db.superuser, "quote");
    agent = await seedAgent(db.superuser);
    rail = await startTestRail(db.as(ROLES.kernel));
  });

  afterAll(async () => {
    await rail?.close();
    await db?.stop();
  });

  async function freshMandate(overrides = {}) {
    const mandateKey =
      (await db.superuser.query<{ kid: string }>(
        `SELECT kid FROM signing_keys WHERE purpose = 'mandate' AND state = 'active'`,
      )).rows[0]?.kid ?? (await seedSigningKey(db.superuser, "mandate")).kid;
    const subject = await seedSubject(db.superuser);
    return seedMandate(db.superuser, {
      agentId: agent.agentId,
      authEventId: subject.authEventId,
      pseudonym: subject.pseudonym,
      kid: mandateKey,
      silentThresholdPaise: 500_000n,
      cumulativePaise: 5_000_000n,
      velocityPerHour: 1_000,
      ...overrides,
    });
  }

  it("cannot sign an anchor as the kernel: only the worker holds that key", async () => {
    await expect(verifyAndAnchor(db.as(ROLES.kernel), MERCHANT_A)).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("expires mandates past not_after so the policy check stays a lookup", async () => {
    const expiring = await freshMandate({ notAfter: new Date(Date.now() - 60_000) });
    const living = await freshMandate();

    const result = await expireMandates(db.as(ROLES.kernel), MERCHANT_A);
    expect(result.details).toContain(expiring);
    expect(result.details).not.toContain(living);

    const states = await withMerchantContext(db.as(ROLES.kernel), MERCHANT_A, async (client) => {
      const r = await client.query<{ mandate_id: string; state: string }>(
        `SELECT mandate_id, state FROM mandates WHERE mandate_id = ANY($1::text[])`,
        [[expiring, living]],
      );
      return Object.fromEntries(r.rows.map((row) => [row.mandate_id, row.state]));
    });
    expect(states[expiring]).toBe("expired");
    expect(states[living]).toBe("live");
  });

  it("releases the hold behind an abandoned step-up", async () => {
    const mandateId = await freshMandate();
    await db.superuser.query(
      `INSERT INTO reservations (reservation_id, mandate_id, merchant_id, intent_id,
         amount_paise, state, step_up)
       VALUES ('rsv_stepup', $1, $2, 'int_stepup', 124000, 'held', true)`,
      [mandateId, MERCHANT_A],
    );
    await db.superuser.query(
      `INSERT INTO challenges (challenge_id, intent_id, mandate_id, merchant_id,
         amount_paise, state, expires_at)
       VALUES ('chl_1', 'int_stepup', $1, $2, 124000, 'pending', now() - interval '1 minute')`,
      [mandateId, MERCHANT_A],
    );

    const result = await expireChallenges(db.as(ROLES.kernel), MERCHANT_A);
    expect(result.changed).toBe(1);

    const reservation = await withMerchantContext(db.as(ROLES.kernel), MERCHANT_A, async (client) => {
      const r = await client.query<{ state: string; release_reason: string | null }>(
        `SELECT state, release_reason FROM reservations WHERE intent_id = 'int_stepup'`);
      return r.rows[0];
    });
    expect(reservation).toMatchObject({ state: "released", release_reason: "step_up_abandoned" });
  });

  it("refunds a payment that landed after revocation, as a compensating entry", async () => {
    const mandateId = await freshMandate();
    await seedCapturedReservation(db.superuser, { mandateId, amountPaise: 1_000n, ageMs: 86_400_000 });

    const quote = await issueQuote(db.superuser, { mandateId, amountPaise: 23_000n, key: quoteKey });
    const kernel = testKernel(db.as(ROLES.kernel), MERCHANT_A, { executor: rail.executor });
    const decision = await authorize(kernel, {
      signedIntent: makeSignedIntent({ agent, mandateId, quote }),
      signedQuote: quote,
    });
    expect(decision.verdict).toBe("ALLOW");

    // The payment captures, then the user revokes. The money already moved.
    const order = await withMerchantContext(db.as(ROLES.kernel), MERCHANT_A, async (client) => {
      const r = await client.query<{ rzp_order_id: string }>(
        `SELECT rzp_order_id FROM orders WHERE intent_id = $1`, [decision.intent_id]);
      return r.rows[0]!.rzp_order_id;
    });
    await rail.replay.settle(order, "captured");

    const railClient = createHttpRail({
      mode: "replay", baseUrl: rail.replay.url, keyId: "k", keySecret: "s", timeoutMs: 2_000,
    });
    const body = JSON.stringify({
      entity: "event", event: "payment.captured", id: `evt_${decision.intent_id}`, created_at: 1,
      payload: { payment: { entity: { id: "pay_r", order_id: order, status: "captured" } } },
    });
    await ingestWebhook(
      { pool: db.as(ROLES.kernel), rail: railClient, webhookSecret: TEST_WEBHOOK_SECRET, merchantId: MERCHANT_A },
      body,
      createHmac("sha256", TEST_WEBHOOK_SECRET).update(body).digest("hex"),
    );

    await revoke(db.as(ROLES.kernel), LOCK_OPTIONS, { mandate_id: mandateId, reason: "user revoked" });

    // The worker holds no payment credential, so the refund goes through the executor.
    const result = await compensateRevoked(db.as(ROLES.kernel), rail.executor, MERCHANT_A);
    expect(result.changed).toBe(1);
    expect(result.details[0]).toContain("COMPLETED");

    const reservation = await withMerchantContext(db.as(ROLES.kernel), MERCHANT_A, async (client) => {
      const r = await client.query<{ state: string; release_reason: string | null }>(
        `SELECT state, release_reason FROM reservations WHERE intent_id = $1`, [decision.intent_id]);
      return r.rows[0];
    });
    expect(reservation).toMatchObject({ state: "released", release_reason: "refunded" });

    // The refund is a compensating entry on the mandate's chain, not an erasure.
    const kinds = await withMerchantContext(db.as(ROLES.kernel), MERCHANT_A, async (client) => {
      const r = await client.query<{ kind: string }>(
        `SELECT kind FROM ledger WHERE chain_id = $1 ORDER BY ledger.seq`, [mandateId]);
      return r.rows.map((row) => row.kind);
    });
    expect(kinds).toContain("REFUND");
    expect(kinds).toContain("EXECUTION_RESULT");
  });

  it("walks every chain and writes a signed anchor", async () => {
    // As the worker, which is the only role granted the anchor key view. The kernel
    // cannot sign an anchor, and has no reason to.
    const result = await verifyAndAnchor(db.as(ROLES.worker), MERCHANT_A);
    expect(result.broken).toEqual([]);
    expect(result.changed).toBeGreaterThan(0);

    const anchors = await db.superuser.query<{ kid: string; sig: Buffer; chain_heads: unknown }>(
      `SELECT kid, sig, chain_heads FROM ledger_anchor`,
    );
    expect(anchors.rows).toHaveLength(1);
    // Signed with the dedicated anchor key, so the checkpoint is attributable.
    expect(anchors.rows[0]!.kid).toMatch(/^kid_anchor_/);
    expect(anchors.rows[0]!.sig.length).toBe(64);
  });

  it("reports a broken chain instead of repairing it", async () => {
    const mandateId = await freshMandate();
    await db.superuser.query(
      `INSERT INTO ledger (chain_id, seq, prev_hash, hash, kind, merchant_id, payload_redacted)
       VALUES ($1, 0, decode(repeat('00',32),'hex'), decode(repeat('aa',32),'hex'),
               'MANDATE_ISSUED', $2, '{"forged":true}')`,
      [mandateId, MERCHANT_A],
    );

    const result = await verifyAndAnchor(db.as(ROLES.worker), MERCHANT_A);
    // Repairing tamper evidence is indistinguishable from tampering, so it is reported.
    expect(result.broken).toContain(mandateId);
  });
});
