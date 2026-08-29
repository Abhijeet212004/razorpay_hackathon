import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bindConsentRefs,
  requestConsent,
  sendOtp,
  verifyAndGrant,
} from "../../src/modules/consent/consent.service.js";
import { ROLES } from "../../src/shared/db/roles.js";
import { startTestDatabase, type TestDatabase } from "../support/postgres.js";
import { MERCHANT_A, seedAgent, seedMerchant, seedSigningKey } from "../support/fixtures.js";

/**
 * Who is approving, and where their order goes.
 *
 * The kernel serves the consent screen from a different origin than the one holding the
 * shopper's session, so it cannot see who they are. The merchant says so instead — but
 * only before the grant exists. Afterwards the delivery target is settled: an agent
 * cannot name an address, so a compromised merchant must not be able to change one on
 * the agent's behalf either.
 */
describe("binding a shopper to a consent request", () => {
  let db: TestDatabase;
  let agentId: string;

  const options = {
    merchantId: MERCHANT_A,
    merchantName: "Sharma Kirana",
    otpTtlMs: 300_000,
    demoMode: true,
  };

  beforeAll(async () => {
    db = await startTestDatabase();
    await seedMerchant(db.superuser);
    await seedSigningKey(db.superuser, "mandate");
    const agent = await seedAgent(db.superuser, "ShopBuddy");
    agentId = agent.agentId;
  });
  afterAll(async () => { await db?.stop(); });

  async function pendingRequest(): Promise<string> {
    const { requestRef } = await requestConsent(db.as(ROLES.kernel), options, {
      agent_id: agentId,
      contact: "+919999999999",
      requested_scope: { merchants: [MERCHANT_A], categories: ["groceries"], currency: "INR" },
      limits: {
        per_transaction_paise: "500000",
        cumulative_paise: "1500000",
        silent_threshold_paise: "50000",
        velocity_per_hour: 3,
      },
    });
    return requestRef;
  }

  const refs = { customerRef: "usr_alice", fulfilmentRef: "addr_home" };

  it("binds a request that has not been granted", async () => {
    const ref = await pendingRequest();
    expect(await bindConsentRefs(db.as(ROLES.kernel), options, ref, refs)).toEqual({
      kind: "BOUND",
    });
  });

  it("refuses a second bind, so a target cannot be swapped before the grant", async () => {
    const ref = await pendingRequest();
    await bindConsentRefs(db.as(ROLES.kernel), options, ref, refs);
    expect(
      await bindConsentRefs(db.as(ROLES.kernel), options, ref, {
        customerRef: "usr_mallory",
        fulfilmentRef: "addr_mallory",
      }),
    ).toEqual({ kind: "ALREADY_BOUND" });
  });

  it("refuses to re-point a mandate that already exists", async () => {
    const ref = await pendingRequest();
    await bindConsentRefs(db.as(ROLES.kernel), options, ref, refs);
    const { code } = await sendOtp(db.as(ROLES.kernel), options, ref);
    const granted = await verifyAndGrant(db.as(ROLES.kernel), options, ref, code!);
    expect(granted.kind).toBe("GRANTED");

    // The goods are now going somewhere. Nothing may move them.
    expect(
      await bindConsentRefs(db.as(ROLES.kernel), options, ref, {
        customerRef: "usr_mallory",
        fulfilmentRef: "addr_mallory",
      }),
    ).toEqual({ kind: "ALREADY_BOUND" });
  });

  it("carries the bound refs onto the mandate", async () => {
    const ref = await pendingRequest();
    await bindConsentRefs(db.as(ROLES.kernel), options, ref, refs);
    const { code } = await sendOtp(db.as(ROLES.kernel), options, ref);
    const granted = await verifyAndGrant(db.as(ROLES.kernel), options, ref, code!);

    const row = await db.superuser.query<{ customer_ref: string; fulfilment_ref: string }>(
      `SELECT customer_ref, fulfilment_ref FROM mandates WHERE mandate_id = $1`,
      [(granted as { mandateId: string }).mandateId],
    );
    expect(row.rows[0]).toEqual({ customer_ref: "usr_alice", fulfilment_ref: "addr_home" });
  });

  it("says so plainly when the reference does not exist", async () => {
    expect(
      await bindConsentRefs(db.as(ROLES.kernel), options, "creq_nope", refs),
    ).toEqual({ kind: "UNKNOWN" });
  });
});
