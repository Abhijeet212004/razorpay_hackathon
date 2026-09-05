import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createExecutor } from "../../src/modules/executor/executor.service.js";
import { createHttpRail } from "../../src/modules/rail/rail.http.js";
import { RailRejectedError } from "../../src/modules/rail/rail.validation.js";
import * as executorRepo from "../../src/modules/executor/executor.repository.js";
import { ROLES } from "../../src/shared/db/roles.js";
import { startTestDatabase, withMerchantContext, type TestDatabase } from "../support/postgres.js";
import { startTestRail, type TestRail } from "../support/kernel.js";
import {
  MERCHANT_A,
  seedAgent,
  seedMandate,
  seedMerchant,
  seedSigningKey,
  seedSubject,
} from "../support/fixtures.js";

/**
 * The payment instrument: the difference between an order nobody pays and money that
 * actually moves while the shopper is asleep.
 *
 * A mandate is a real grant with or without one. Without, the executor can create an
 * order and nothing more. With, it debits an instrument the shopper's own bank
 * authorised — and the token can only have come from the rail, never from an agent.
 */
describe("charging a mandate's instrument", () => {
  let db: TestDatabase;
  let rail: TestRail;
  let mandateId: string;
  let mandateKid: string;

  beforeAll(async () => {
    db = await startTestDatabase();
    await seedMerchant(db.superuser);
    const mandateKey = await seedSigningKey(db.superuser, "mandate");
    mandateKid = mandateKey.kid;
    const agent = await seedAgent(db.superuser);
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
    rail = await startTestRail(db.as(ROLES.kernel));
  });

  afterAll(async () => {
    await rail?.close();
    await db?.stop();
  });

  function railClient() {
    return createHttpRail({
      mode: "replay",
      baseUrl: rail.replay.url,
      keyId: "k",
      keySecret: "s",
      timeoutMs: 3_000,
    });
  }

  it("creates an order but moves no money when no instrument is attached", async () => {
    const executor = createExecutor({ pool: db.as(ROLES.kernel), rail: railClient() });
    const result = await executor.execute({
      intentId: "int_no_instrument",
      mandateId,
      merchantId: MERCHANT_A,
      amountPaise: 4_500n,
      decisionId: "dec_no_instrument",
    });

    expect(result.state).toBe("SUBMITTED");
    const order = rail.replay.orders.get(result.railOrderId!);
    // Created, unpaid. An agent with no instrument cannot conjure one.
    expect(order?.status).toBe("created");
  });

  it("leaves the order payable when the rail refuses the auto-debit", async () => {
    /**
     * The order and the debit are two different facts.
     *
     * An acquirer can refuse a recurring charge for reasons that have nothing to do with
     * this order: recurring not enabled on the account, a token the network never
     * activated, a mandate the issuer dropped. The rail order is still live and payable.
     *
     * This used to mark the whole order FAILED and release the hold, so the shopper was
     * shown a pay page for an order the kernel had already abandoned. They paid, it
     * captured, and it reconciled against nothing.
     */
    const executor = createExecutor({
      pool: db.as(ROLES.kernel),
      rail: {
        ...railClient(),
        // Order creation succeeds; the debit is refused, as Razorpay does when recurring
        // is not enabled for the merchant.
        chargeToken: async () => {
          throw new RailRejectedError("payments.recurring", "BAD_REQUEST_ERROR", 400, "Payment failed");
        },
      },
    });

    const agent = await seedAgent(db.superuser);
    const subject = await seedSubject(db.superuser);
    const withInstrument = await seedMandate(db.superuser, {
      agentId: agent.agentId,
      authEventId: subject.authEventId,
      pseudonym: subject.pseudonym,
      kid: mandateKid,
      silentThresholdPaise: 500_000n,
      cumulativePaise: 5_000_000n,
      velocityPerHour: 1_000,
    });
    await db.superuser.query(
      `UPDATE mandates SET payment_customer_ref = $2, payment_token_ref = $3, payment_max_paise = $4
        WHERE mandate_id = $1`,
      [withInstrument, "cust_x", "token_x", "500000"],
    );

    const result = await executor.execute({
      intentId: "int_debit_refused",
      mandateId: withInstrument,
      merchantId: MERCHANT_A,
      amountPaise: 4_500n,
      decisionId: "dec_debit_refused",
    });

    // Payable, not failed: the shopper can still pay it and it will reconcile.
    expect(result.state).toBe("SUBMITTED");
    expect(result.railOrderId).not.toBeNull();
    expect(rail.replay.orders.get(result.railOrderId!)?.status).toBe("created");
  });

  it("refuses to charge a token the bank never authorised", async () => {
    const client = railClient();
    const customer = await client.createCustomer({
      name: "Shopper", email: "s@example.com", contact: "9876543210",
    });
    const order = await client.createOrder({
      amountPaise: 4_500n, currency: "INR", idempotencyKey: "k1", notes: {},
    });

    await expect(
      client.chargeToken({
        customerId: customer.customerId,
        tokenId: "token_forged",
        railOrderId: order.railOrderId,
        amountPaise: 4_500n,
        description: "forged",
      }),
    ).rejects.toThrow();
  });

  it("debits the instrument once the shopper's bank has authorised it", async () => {
    const client = railClient();

    // What consent does: a customer, a registration order, then the bank approving it.
    const customer = await client.createCustomer({
      name: "Shopper", email: "s@example.com", contact: "9876543210",
    });
    const registration = await client.createMandateOrder({
      customerId: customer.customerId,
      maxAmountPaise: 500_000n,
      amountPaise: 100n,
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      method: "upi",
      notes: { mandate_id: mandateId },
    });

    expect(await client.findToken(customer.customerId)).toBeNull();
    await rail.replay.settle(registration.railOrderId);
    const token = await client.findToken(customer.customerId);
    expect(token).not.toBeNull();

    await withMerchantContext(db.as(ROLES.kernel), MERCHANT_A, (c) =>
      executorRepo.attachPaymentInstrument(c, mandateId, {
        customerId: customer.customerId,
        tokenId: token!.tokenId,
        maxAmountPaise: token!.maxAmountPaise,
      }),
    );

    const executor = createExecutor({ pool: db.as(ROLES.kernel), rail: railClient() });
    const result = await executor.execute({
      intentId: "int_with_instrument",
      mandateId,
      merchantId: MERCHANT_A,
      amountPaise: 4_500n,
      decisionId: "dec_with_instrument",
    });

    expect(result.state).toBe("SUBMITTED");
    // The order was paid without anyone being asked for anything.
    const order = rail.replay.orders.get(result.railOrderId!);
    expect(order?.status).toBe("paid");
    expect(order?.amount_paid).toBe(4_500);
  });

  it("gives the cap back when the rail refuses the call", async () => {
    // A rail that answers and says no. The money certainly did not move, so holding cap
    // for it would spend the shopper's budget on a purchase that never happened — and
    // nothing else would ever release it: the reaper skips intents that have an order
    // row, and the reconciler only scans non-terminal states.
    const refusing = createHttpRail({
      mode: "replay",
      baseUrl: `${rail.replay.url}/nope`,
      keyId: "k",
      keySecret: "s",
      timeoutMs: 3_000,
    });

    await db.superuser.query(
      `INSERT INTO reservations (reservation_id, mandate_id, merchant_id, intent_id,
         amount_paise, state) VALUES ($1, $2, $3, $4, 4500, 'held')`,
      ["rsv_refused", mandateId, MERCHANT_A, "int_refused"],
    );

    const executor = createExecutor({ pool: db.as(ROLES.kernel), rail: refusing });
    const result = await executor.execute({
      intentId: "int_refused",
      mandateId,
      merchantId: MERCHANT_A,
      amountPaise: 4_500n,
      decisionId: "dec_refused",
    });
    expect(result.state).toBe("FAILED");

    const state = await withMerchantContext(db.as(ROLES.kernel), MERCHANT_A, async (c) => {
      const r = await c.query<{ state: string; release_reason: string | null }>(
        `SELECT state, release_reason FROM reservations WHERE intent_id = 'int_refused'`);
      return r.rows[0];
    });
    expect(state?.state).toBe("released");
    expect(state?.release_reason).toBe("payment_failed");
  });

  it("reads the instrument from the mandate, never from the caller", async () => {
    const stored = await withMerchantContext(db.as(ROLES.kernel), MERCHANT_A, (c) =>
      executorRepo.findPaymentInstrument(c, mandateId),
    );
    expect(stored?.tokenId).toMatch(/^token_/);

    // There is no field on an execute request for an instrument, so an agent has nothing
    // to supply and nothing to substitute.
    const keys = ["intentId", "mandateId", "merchantId", "amountPaise", "decisionId"];
    expect(keys).not.toContain("tokenId");
    expect(keys).not.toContain("customerId");
  });
});
