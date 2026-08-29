import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authorize } from "../../src/modules/authorization/authorization.service.js";
import { ingestWebhook } from "../../src/modules/reconciler/reconciler.service.js";
import { releaseStaleReservations } from "../../src/modules/jobs/release-stale.job.js";
import { reconcileAmbiguous } from "../../src/modules/jobs/reconcile-ambiguous.job.js";
import { JOB_TIMINGS } from "../../src/modules/jobs/jobs.validation.js";
import { createHttpRail } from "../../src/modules/rail/rail.http.js";
import { createExecutor } from "../../src/modules/executor/executor.service.js";
import { ROLES } from "../../src/shared/db/roles.js";
import { startTestDatabase, withMerchantContext, type TestDatabase } from "../support/postgres.js";
import { TEST_WEBHOOK_SECRET, startTestRail, testKernel, type TestRail } from "../support/kernel.js";
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
 * INV-04, INV-07, INV-15, INV-20 — settlement.
 * INV-03 is covered by the policy rules the compromised-model suite drives.
 *
 * Everything below runs against a real HTTP server on a real socket serving recorded
 * response shapes. Our executor, HMAC verification, event dedupe and orders.fetch all
 * genuinely execute; only the far side of the socket is a recording.
 */
describe("settlement", () => {
  let db: TestDatabase;
  let agent: SeededAgent;
  let quoteKey: SeededKey;
  let mandateId: string;

  beforeAll(async () => {
    db = await startTestDatabase();
    await seedMerchant(db.superuser);
    const mandateKey = await seedSigningKey(db.superuser, "mandate");
    quoteKey = await seedSigningKey(db.superuser, "quote");
    agent = await seedAgent(db.superuser);
    const subject = await seedSubject(db.superuser);

    mandateId = await seedMandate(db.superuser, {
      agentId: agent.agentId,
      authEventId: subject.authEventId,
      pseudonym: subject.pseudonym,
      kid: mandateKey.kid,
      silentThresholdPaise: 500_000n,
      cumulativePaise: 5_000_000n,
      velocityPerHour: 1_000,
    });
    await seedCapturedReservation(db.superuser, {
      mandateId,
      amountPaise: 10_000n,
      ageMs: 86_400_000,
    });
  });

  afterAll(async () => {
    await db?.stop();
  });

  async function purchase(rail: TestRail, amountPaise: bigint) {
    const quote = await issueQuote(db.superuser, { mandateId, amountPaise, key: quoteKey });
    const kernel = testKernel(db.as(ROLES.kernel), MERCHANT_A, { executor: rail.executor });
    const decision = await authorize(kernel, {
      signedIntent: makeSignedIntent({ agent, mandateId, quote }),
      signedQuote: quote,
    });
    return decision;
  }

  const orderFor = (intentId: string) =>
    withMerchantContext(db.as(ROLES.kernel), MERCHANT_A, async (client) => {
      const result = await client.query<{ state: string; rzp_order_id: string | null }>(
        `SELECT state, rzp_order_id FROM orders WHERE intent_id = $1`,
        [intentId],
      );
      return result.rows[0] ?? null;
    });

  const reservationFor = (intentId: string) =>
    withMerchantContext(db.as(ROLES.kernel), MERCHANT_A, async (client) => {
      const result = await client.query<{ state: string; release_reason: string | null }>(
        `SELECT state, release_reason FROM reservations WHERE intent_id = $1`,
        [intentId],
      );
      return result.rows[0] ?? null;
    });

  it("carries the intent id into the rail's notes, so the dashboard joins to the ledger", async () => {
    const rail = await startTestRail(db.as(ROLES.kernel));
    try {
      const decision = await purchase(rail, 12_000n);
      const order = await orderFor(decision.intent_id);
      const railOrder = rail.replay.orders.get(order!.rzp_order_id!);

      expect(railOrder?.notes.intent_id).toBe(decision.intent_id);
      expect(railOrder?.notes.decision_id).toBe(decision.decision_id);
    } finally {
      await rail.close();
    }
  });

  it("captures on a signed webhook, confirmed by reading the rail", async () => {
    const rail = await startTestRail(db.as(ROLES.kernel));
    try {
      const decision = await purchase(rail, 13_000n);
      const order = await orderFor(decision.intent_id);
      expect(order?.state).toBe("SUBMITTED");
      expect(await reservationFor(decision.intent_id)).toMatchObject({ state: "held" });

      await rail.replay.settle(order!.rzp_order_id!, "captured");

      const railClient = createHttpRail({
        mode: "replay",
        baseUrl: rail.replay.url,
        keyId: "k",
        keySecret: "s",
        timeoutMs: 2_000,
      });

      const body = JSON.stringify({
        entity: "event",
        event: "payment.captured",
        id: "evt_capture_001",
        created_at: 1,
        payload: {
          payment: {
            entity: { id: "pay_x", order_id: order!.rzp_order_id!, status: "captured" },
          },
        },
      });
      const signature = createHmac("sha256", TEST_WEBHOOK_SECRET).update(body).digest("hex");

      const outcome = await ingestWebhook(
        { pool: db.as(ROLES.kernel), rail: railClient, webhookSecret: TEST_WEBHOOK_SECRET, merchantId: MERCHANT_A },
        body,
        signature,
      );

      expect(outcome.kind).toBe("APPLIED");
      expect(await orderFor(decision.intent_id)).toMatchObject({ state: "CAPTURED" });
      // held -> captured keeps the amount inside the cap sum, so the total is unchanged.
      expect(await reservationFor(decision.intent_id)).toMatchObject({ state: "captured" });

      // The same event delivered twice must not apply twice.
      const again = await ingestWebhook(
        { pool: db.as(ROLES.kernel), rail: railClient, webhookSecret: TEST_WEBHOOK_SECRET, merchantId: MERCHANT_A },
        body,
        signature,
      );
      expect(again.kind).toBe("DUPLICATE");
    } finally {
      await rail.close();
    }
  });

  it("refuses a webhook whose signature does not verify", async () => {
    const rail = await startTestRail(db.as(ROLES.kernel));
    try {
      const railClient = createHttpRail({
        mode: "replay", baseUrl: rail.replay.url, keyId: "k", keySecret: "s", timeoutMs: 2_000,
      });
      const body = JSON.stringify({
        entity: "event", event: "payment.captured", id: "evt_forged", created_at: 1,
        payload: { payment: { entity: { id: "pay_f", order_id: "order_f", status: "captured" } } },
      });

      const deps = { pool: db.as(ROLES.kernel), rail: railClient, webhookSecret: TEST_WEBHOOK_SECRET, merchantId: MERCHANT_A };
      expect((await ingestWebhook(deps, body, "00".repeat(32))).kind).toBe("UNVERIFIED");
      expect((await ingestWebhook(deps, body, undefined)).kind).toBe("UNVERIFIED");
      // A body edited after signing no longer verifies.
      const signature = createHmac("sha256", TEST_WEBHOOK_SECRET).update(body).digest("hex");
      expect((await ingestWebhook(deps, `${body} `, signature)).kind).toBe("UNVERIFIED");
    } finally {
      await rail.close();
    }
  });

  it("charges once when the same intent is executed twice", async () => {
    const rail = await startTestRail(db.as(ROLES.kernel));
    try {
      const decision = await purchase(rail, 14_000n);
      const order = await orderFor(decision.intent_id);

      // The executor is asked again with the same intent, as a crashed retry would.
      const second = await rail.executor.execute({
        intentId: decision.intent_id,
        mandateId,
        merchantId: MERCHANT_A,
        amountPaise: 14_000n,
        decisionId: decision.decision_id,
      });

      expect(second.railOrderId).toBe(order!.rzp_order_id);

      const railOrdersForThisIntent = [...rail.replay.orders.values()].filter(
        (o) => o.notes.intent_id === decision.intent_id,
      );
      expect(railOrdersForThisIntent).toHaveLength(1);
    } finally {
      await rail.close();
    }
  });
});

describe("ambiguity is resolved by reading, never by retrying", () => {
  let db: TestDatabase;
  let agent: SeededAgent;
  let quoteKey: SeededKey;
  let mandateId: string;

  beforeAll(async () => {
    db = await startTestDatabase();
    await seedMerchant(db.superuser);
    const mandateKey = await seedSigningKey(db.superuser, "mandate");
    quoteKey = await seedSigningKey(db.superuser, "quote");
    agent = await seedAgent(db.superuser);
    const subject = await seedSubject(db.superuser);
    mandateId = await seedMandate(db.superuser, {
      agentId: agent.agentId,
      authEventId: subject.authEventId,
      pseudonym: subject.pseudonym,
      kid: mandateKey.kid,
      silentThresholdPaise: 500_000n,
      cumulativePaise: 5_000_000n,
      velocityPerHour: 1_000,
    });
    await seedCapturedReservation(db.superuser, { mandateId, amountPaise: 10_000n, ageMs: 86_400_000 });
  });

  afterAll(async () => {
    await db?.stop();
  });

  it("keeps the reservation held while the outcome is unknown, then resolves it", async () => {
    // The rail accepts the order and never sends a terminal webhook.
    const rail = await startTestRail(db.as(ROLES.kernel), { goSilent: true });
    try {
      const quote = await issueQuote(db.superuser, { mandateId, amountPaise: 21_000n, key: quoteKey });
      const kernel = testKernel(db.as(ROLES.kernel), MERCHANT_A, { executor: rail.executor });
      const decision = await authorize(kernel, {
        signedIntent: makeSignedIntent({ agent, mandateId, quote }),
        signedQuote: quote,
      });

      const held = await withMerchantContext(db.as(ROLES.kernel), MERCHANT_A, async (client) => {
        const r = await client.query<{ state: string }>(
          `SELECT state FROM reservations WHERE intent_id = $1`, [decision.intent_id]);
        return r.rows[0]?.state;
      });
      // We do not know whether the money moved, so the cap must keep assuming it did.
      expect(held).toBe("held");

      const railClient = createHttpRail({
        mode: "replay", baseUrl: rail.replay.url, keyId: "k", keySecret: "s", timeoutMs: 2_000,
      });

      // Nothing happens while the rail still says "created": reconciliation reads, and
      // reading tells it nothing yet.
      const first = await reconcileAmbiguous(db.as(ROLES.kernel), railClient, MERCHANT_A);
      expect(first.changed).toBe(0);

      // The payment did land, we simply never heard. Reading finds it.
      const order = await withMerchantContext(db.as(ROLES.kernel), MERCHANT_A, async (client) => {
        const r = await client.query<{ rzp_order_id: string }>(
          `SELECT rzp_order_id FROM orders WHERE intent_id = $1`, [decision.intent_id]);
        return r.rows[0]!.rzp_order_id;
      });
      await rail.replay.settle(order, "captured");

      const second = await reconcileAmbiguous(db.as(ROLES.kernel), railClient, MERCHANT_A);
      expect(second.changed).toBe(1);
      expect(second.details[0]).toContain("CAPTURED");

      const after = await withMerchantContext(db.as(ROLES.kernel), MERCHANT_A, async (client) => {
        const r = await client.query<{ state: string }>(
          `SELECT state FROM orders WHERE intent_id = $1`, [decision.intent_id]);
        return r.rows[0]?.state;
      });
      expect(after).toBe("CAPTURED");
    } finally {
      await rail.close();
    }
  });

  it("gives up after the maximum age and says so, rather than holding cap forever", async () => {
    const rail = await startTestRail(db.as(ROLES.kernel), { goSilent: true });
    try {
      const quote = await issueQuote(db.superuser, { mandateId, amountPaise: 22_000n, key: quoteKey });
      const kernel = testKernel(db.as(ROLES.kernel), MERCHANT_A, { executor: rail.executor });
      const decision = await authorize(kernel, {
        signedIntent: makeSignedIntent({ agent, mandateId, quote }),
        signedQuote: quote,
      });

      const railClient = createHttpRail({
        mode: "replay", baseUrl: rail.replay.url, keyId: "k", keySecret: "s", timeoutMs: 2_000,
      });

      // Twenty-five hours later, still nothing.
      const later = new Date(Date.now() + 25 * 60 * 60_000);
      const result = await reconcileAmbiguous(db.as(ROLES.kernel), railClient, MERCHANT_A, later);

      expect(result.details.some((d) => d.includes("FAILED_UNRESOLVED"))).toBe(true);

      const reservation = await withMerchantContext(db.as(ROLES.kernel), MERCHANT_A, async (client) => {
        const r = await client.query<{ state: string; release_reason: string | null }>(
          `SELECT state, release_reason FROM reservations WHERE intent_id = $1`,
          [decision.intent_id]);
        return r.rows[0];
      });
      // The cap recovers, and the ledger says plainly that we never found out.
      expect(reservation).toMatchObject({ state: "released", release_reason: "unresolved" });
    } finally {
      await rail.close();
    }
  });
});

describe("the reaper", () => {
  let db: TestDatabase;
  let mandateId: string;

  beforeAll(async () => {
    db = await startTestDatabase();
    await seedMerchant(db.superuser);
    const mandateKey = await seedSigningKey(db.superuser, "mandate");
    const agent = await seedAgent(db.superuser);
    const subject = await seedSubject(db.superuser);
    mandateId = await seedMandate(db.superuser, {
      agentId: agent.agentId,
      authEventId: subject.authEventId,
      pseudonym: subject.pseudonym,
      kid: mandateKey.kid,
    });
  });

  afterAll(async () => {
    await db?.stop();
  });

  async function seedHold(intentId: string, ageMinutes: number, withOrder: string | null) {
    await db.superuser.query(
      `INSERT INTO reservations (reservation_id, mandate_id, merchant_id, intent_id,
         amount_paise, state, created_at)
       VALUES ($1, $2, $3, $4, 5000, 'held', now() - make_interval(mins => $5))`,
      [`rsv_${intentId}`, mandateId, MERCHANT_A, intentId, ageMinutes],
    );
    if (withOrder !== null) {
      await db.superuser.query(
        `INSERT INTO orders (order_id, intent_id, mandate_id, merchant_id, amount_paise,
           state, idempotency_key)
         VALUES ($1, $2, $3, $4, 5000, $5, $6)`,
        [`ord_${intentId}`, intentId, mandateId, MERCHANT_A, withOrder, "a".repeat(64)],
      );
    }
  }

  it("reaps a hold that never reached the executor, and nothing else", async () => {
    await seedHold("int_crashed", 30, null);        // crash before execution: reapable
    await seedHold("int_fresh", 1, null);           // too young
    await seedHold("int_submitted", 30, "SUBMITTED"); // the reconciler owns this one
    await seedHold("int_ambiguous", 30, "AMBIGUOUS"); // and this one

    const result = await releaseStaleReservations(db.as(ROLES.kernel), MERCHANT_A);

    expect(result.changed).toBe(1);
    expect(result.details).toEqual(["rsv_int_crashed"]);

    const states = await withMerchantContext(db.as(ROLES.kernel), MERCHANT_A, async (client) => {
      const r = await client.query<{ intent_id: string; state: string; release_reason: string | null }>(
        `SELECT intent_id, state, release_reason FROM reservations ORDER BY intent_id`);
      return Object.fromEntries(r.rows.map((row) => [row.intent_id, row]));
    });

    expect(states.int_crashed).toMatchObject({ state: "released", release_reason: "reaped" });
    expect(states.int_fresh?.state).toBe("held");
    // Never reaped while the outcome is unknown: we do not know whether money moved.
    expect(states.int_submitted?.state).toBe("held");
    expect(states.int_ambiguous?.state).toBe("held");
  });
});

/**
 * The order row is written before the outbound call, so the absence of a row means the
 * executor is certain it never reached the rail.
 */
describe("a timeout is not a call that never happened", () => {
  let db: TestDatabase;
  let agent: SeededAgent;
  let quoteKey: SeededKey;
  let mandateId: string;

  beforeAll(async () => {
    db = await startTestDatabase();
    await seedMerchant(db.superuser);
    const mandateKey = await seedSigningKey(db.superuser, "mandate");
    quoteKey = await seedSigningKey(db.superuser, "quote");
    agent = await seedAgent(db.superuser);
    const subject = await seedSubject(db.superuser);
    mandateId = await seedMandate(db.superuser, {
      agentId: agent.agentId,
      authEventId: subject.authEventId,
      pseudonym: subject.pseudonym,
      kid: mandateKey.kid,
      silentThresholdPaise: 500_000n,
      cumulativePaise: 5_000_000n,
      velocityPerHour: 1_000,
    });
    await seedCapturedReservation(db.superuser, { mandateId, amountPaise: 1_000n, ageMs: 86_400_000 });
  });

  afterAll(async () => {
    await db?.stop();
  });

  it("leaves an order row when the rail never answers, so the hold is not reaped", async () => {
    // A rail that accepts the connection and never responds. The executor times out.
    const blackHole = createServer((_req, res) => {
      // Deliberately no response, and no destroy: the client must hit its own timeout.
      void res;
    });
    await new Promise<void>((resolve) => blackHole.listen(0, "127.0.0.1", resolve));
    const address = blackHole.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    try {
      const rail = createHttpRail({
        mode: "replay",
        baseUrl: `http://127.0.0.1:${port}`,
        keyId: "k",
        keySecret: "s",
        timeoutMs: 300,
      });
      const executor = createExecutor({ pool: db.as(ROLES.kernel), rail });

      const quote = await issueQuote(db.superuser, { mandateId, amountPaise: 31_000n, key: quoteKey });
      const kernel = testKernel(db.as(ROLES.kernel), MERCHANT_A, { executor });
      const decision = await authorize(kernel, {
        signedIntent: makeSignedIntent({ agent, mandateId, quote }),
        signedQuote: quote,
      });
      expect(decision.verdict).toBe("ALLOW");

      const order = await withMerchantContext(db.as(ROLES.kernel), MERCHANT_A, async (client) => {
        const r = await client.query<{ state: string; rzp_order_id: string | null }>(
          `SELECT state, rzp_order_id FROM orders WHERE intent_id = $1`, [decision.intent_id]);
        return r.rows[0];
      });

      // The row exists even though the call never returned. Without it the reaper would
      // conclude no call was made, and release a hold for money that may have moved.
      expect(order).toBeDefined();
      expect(order!.state).toBe("AMBIGUOUS");
      expect(order!.rzp_order_id).toBeNull();

      // The reaper leaves it alone: an order row exists, so the reconciler owns it.
      const reaped = await releaseStaleReservations(
        db.as(ROLES.kernel),
        MERCHANT_A,
        new Date(Date.now() + 30 * 60_000),
      );
      expect(reaped.details).not.toContain(`rsv_${decision.intent_id}`);

      const reservation = await withMerchantContext(db.as(ROLES.kernel), MERCHANT_A, async (client) => {
        const r = await client.query<{ state: string }>(
          `SELECT state FROM reservations WHERE intent_id = $1`, [decision.intent_id]);
        return r.rows[0]?.state;
      });
      expect(reservation).toBe("held");
    } finally {
      await new Promise<void>((resolve) => blackHole.close(() => resolve()));
    }
  });

  it("adopts an order the rail already has instead of creating a second", async () => {
    const rail = await startTestRail(db.as(ROLES.kernel));
    try {
      // The lost-answer case: the call landed, the order exists on the rail, and the
      // process died before the id could be stored.
      const created = await fetch(`${rail.replay.url}/v1/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: 32000,
          currency: "INR",
          notes: { intent_id: "int_stuck" },
        }),
      }).then((r) => r.json() as Promise<{ id: string }>);

      await db.superuser.query(
        `INSERT INTO reservations (reservation_id, mandate_id, merchant_id, intent_id,
           amount_paise, state) VALUES ($1, $2, $3, $4, 32000, 'held')`,
        ["rsv_stuck", mandateId, MERCHANT_A, "int_stuck"],
      );
      await db.superuser.query(
        `INSERT INTO orders (order_id, intent_id, mandate_id, merchant_id, amount_paise,
           state, idempotency_key)
         VALUES ('ord_stuck', 'int_stuck', $1, $2, 32000, 'SUBMITTING', $3)`,
        [mandateId, MERCHANT_A, "b".repeat(64)],
      );

      const railClient = createHttpRail({
        mode: "replay", baseUrl: rail.replay.url, keyId: "k", keySecret: "s", timeoutMs: 2_000,
      });

      const result = await reconcileAmbiguous(db.as(ROLES.kernel), railClient, MERCHANT_A);
      expect(result.examined).toBeGreaterThan(0);

      // The whole point: still one order for this intent. The rail does not dedupe, so
      // anything that issued a create here would have left a second, payable order.
      const railOrders = [...rail.replay.orders.values()].filter(
        (o) => o.notes.intent_id === "int_stuck",
      );
      expect(railOrders).toHaveLength(1);

      // And the row now points at the order that already existed, so a webhook naming it
      // can be attributed.
      const row = await withMerchantContext(db.as(ROLES.kernel), MERCHANT_A, async (client) => {
        const r = await client.query<{ state: string; rzp_order_id: string | null }>(
          `SELECT state, rzp_order_id FROM orders WHERE intent_id = 'int_stuck'`);
        return r.rows[0];
      });
      expect(row?.rzp_order_id).toBe(created.id);
      expect(row?.state).not.toBe("SUBMITTING");
    } finally {
      await rail.close();
    }
  });

  it("never creates an order for an intent the rail never saw", async () => {
    const rail = await startTestRail(db.as(ROLES.kernel));
    try {
      await db.superuser.query(
        `INSERT INTO reservations (reservation_id, mandate_id, merchant_id, intent_id,
           amount_paise, state) VALUES ($1, $2, $3, $4, 32000, 'held')`,
        ["rsv_never", mandateId, MERCHANT_A, "int_never"],
      );
      await db.superuser.query(
        `INSERT INTO orders (order_id, intent_id, mandate_id, merchant_id, amount_paise,
           state, idempotency_key)
         VALUES ('ord_never', 'int_never', $1, $2, 32000, 'SUBMITTING', $3)`,
        [mandateId, MERCHANT_A, "c".repeat(64)],
      );

      const railClient = createHttpRail({
        mode: "replay", baseUrl: rail.replay.url, keyId: "k", keySecret: "s", timeoutMs: 2_000,
      });

      // Reconciling is a read. It establishes what happened; it does not go on to make a
      // purchase the shopper is no longer expecting.
      await reconcileAmbiguous(db.as(ROLES.kernel), railClient, MERCHANT_A);
      expect(
        [...rail.replay.orders.values()].filter((o) => o.notes.intent_id === "int_never"),
      ).toHaveLength(0);

      // Past the window it is given up on, loudly, and the hold is released so the cap
      // recovers rather than being pinned forever by an outcome we never established.
      const later = new Date(Date.now() + JOB_TIMINGS.reconcileMaxAgeMs + 60_000);
      const result = await reconcileAmbiguous(db.as(ROLES.kernel), railClient, MERCHANT_A, later);
      expect(result.details.join(",")).toContain("FAILED_UNRESOLVED");

      const reservation = await withMerchantContext(db.as(ROLES.kernel), MERCHANT_A, async (client) => {
        const r = await client.query<{ state: string }>(
          `SELECT state FROM reservations WHERE intent_id = 'int_never'`);
        return r.rows[0]?.state;
      });
      expect(reservation).not.toBe("held");
    } finally {
      await rail.close();
    }
  });
});
