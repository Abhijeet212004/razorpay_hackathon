import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authorize } from "../../src/modules/authorization/authorization.service.js";
import { revoke } from "../../src/modules/mandate/mandate.service.js";
import { ROLES } from "../../src/shared/db/roles.js";
import { startTestDatabase, withMerchantContext, type TestDatabase } from "../support/postgres.js";
import { testKernel } from "../support/kernel.js";
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
 * INV-09 — revocation takes the same row lock authorisation takes, so the two cannot interleave.
 * Without that, a revocation could land between an authorisation's mandate read and its
 * reservation write, and the payment would proceed against authority the user had
 * already withdrawn.
 */
describe("revocation contends with authorisation for one row", () => {
  let db: TestDatabase;
  let agent: SeededAgent;
  let quoteKey: SeededKey;
  let mandateId: string;

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

  it("denies every intent that races a revocation, and never half-applies one", async () => {
    const kernel = testKernel(db.as(ROLES.kernel), MERCHANT_A);

    const requests = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const quote = await issueQuote(db.superuser, {
          mandateId,
          amountPaise: 10_000n,
          key: quoteKey,
        });
        return { signedIntent: makeSignedIntent({ agent, mandateId, quote }), signedQuote: quote };
      }),
    );

    // Fired together: the revocation lands somewhere in the middle of the run.
    const [revocation, ...decisions] = await Promise.all([
      revoke(db.as(ROLES.kernel), lockOptions, { mandate_id: mandateId, reason: "user revoked" }),
      ...requests.map((request) => authorize(kernel, request)),
    ]);

    expect(revocation?.alreadyRevoked).toBe(false);

    const allowed = decisions.filter((d) => d.verdict === "ALLOW");
    const revokedDenials = decisions.filter((d) => d.reason_code === "MND-003");

    // Every intent either completed before revocation or was denied by it. Nothing lands
    // in between, because both paths serialise on the same row.
    expect(allowed.length + revokedDenials.length).toBe(decisions.length);

    await withMerchantContext(db.as(ROLES.kernel), MERCHANT_A, async (client) => {
      const reservations = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM reservations
          WHERE mandate_id = $1 AND state = 'held'`,
        [mandateId],
      );
      // One held reservation per ALLOW, and no more: no intent both passed the cap check
      // and failed to write its hold.
      expect(Number(reservations.rows[0]!.count)).toBe(allowed.length);

      const state = await client.query<{ state: string }>(
        `SELECT state FROM mandates WHERE mandate_id = $1`,
        [mandateId],
      );
      expect(state.rows[0]!.state).toBe("revoked");
    });
  });

  it("reports reservations still held when revocation landed rather than cancelling them", async () => {
    // The money may already be in flight. It is resolved by reading provider state and
    // refunding, never by pretending the authorisation did not happen.
    expect(Array.isArray((await revoke(db.as(ROLES.kernel), lockOptions, {
      mandate_id: mandateId,
      reason: "second revoke",
    }))?.heldReservationIds)).toBe(true);
  });

  it("is idempotent", async () => {
    const again = await revoke(db.as(ROLES.kernel), lockOptions, {
      mandate_id: mandateId,
      reason: "third revoke",
    });
    expect(again?.alreadyRevoked).toBe(true);
    expect(again?.ledgerSeq).toBeNull();
  });
});
