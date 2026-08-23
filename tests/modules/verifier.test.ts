import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_KERNEL_CONFIG,
  authorize,
} from "../../src/modules/authorization/authorization.service.js";
import type {
  BlindVerifier,
  VerifierOutcome,
} from "../../src/modules/verifier/verifier.validation.js";
import { ROLES } from "../../src/shared/db/roles.js";
import { startTestDatabase, type TestDatabase } from "../support/postgres.js";
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
 * INV-17 — the blind verifier may only downgrade, and its unavailability never grants.
 *
 * The strongest half is not tested at runtime at all: VerifierOutcome has no ALLOW
 * member, so a verifier that tried to grant would not compile. What is tested here is
 * everything the type cannot say — that an objection denies, and that being unreachable
 * denies above the silent threshold rather than falling through.
 */
describe("the blind verifier can only subtract", () => {
  let db: TestDatabase;
  let agent: SeededAgent;
  let quoteKey: SeededKey;
  let mandateId: string;

  const SILENT_THRESHOLD = 50_000n;

  const verifierReturning = (outcome: VerifierOutcome): BlindVerifier => ({
    assess: () => Promise.resolve(outcome),
  });

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
      silentThresholdPaise: SILENT_THRESHOLD,
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

  async function decide(verifier: BlindVerifier, amountPaise: bigint) {
    const quote = await issueQuote(db.superuser, { mandateId, amountPaise, key: quoteKey });
    const kernel = testKernel(db.as(ROLES.kernel), MERCHANT_A, {
      verifier,
      config: { ...DEFAULT_KERNEL_CONFIG, merchantId: MERCHANT_A },
    });
    return authorize(kernel, {
      signedIntent: makeSignedIntent({ agent, mandateId, quote }),
      signedQuote: quote,
    });
  }

  it("denies SEC-004 when the verifier objects", async () => {
    const decision = await decide(
      verifierReturning({ kind: "DENY", detail: "implausible basket" }),
      12_000n,
    );
    expect(decision.verdict).toBe("DENY");
    expect(decision.reason_code).toBe("SEC-004");
  });

  it("never leaks the verifier's reasoning into the decision", async () => {
    // Surfacing why it objected is an oracle for tuning attacks against it.
    const decision = await decide(
      verifierReturning({ kind: "DENY", detail: "basket similarity 0.31 below 0.6" }),
      12_000n,
    );
    const serialised = JSON.stringify(decision);
    expect(serialised).not.toContain("similarity");
    expect(serialised).not.toContain("0.31");
  });

  it("denies SYS-002 when unavailable above the silent threshold", async () => {
    const decision = await decide(
      verifierReturning({ kind: "UNAVAILABLE", detail: "timeout" }),
      SILENT_THRESHOLD + 1n,
    );
    expect(decision.reason_code).toBe("SYS-002");
  });

  it("proceeds when unavailable below the silent threshold", async () => {
    // Fail-closed on every request would turn an inference outage into a commerce outage.
    // Below the threshold the skip is recorded and the remaining checks still run.
    const decision = await decide(
      verifierReturning({ kind: "UNAVAILABLE", detail: "timeout" }),
      12_000n,
    );
    expect(decision.verdict).toBe("ALLOW");
  });

  it("cannot grant: PROCEED still faces every check under the lock", async () => {
    // The mandate's per-transaction cap is ₹5,000. No verifier answer can lift it.
    const decision = await decide(verifierReturning({ kind: "PROCEED" }), 5_000_000n);
    expect(decision.reason_code).toBe("LMT-001");
  });
});
