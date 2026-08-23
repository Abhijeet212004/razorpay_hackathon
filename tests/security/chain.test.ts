import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authorize } from "../../src/modules/authorization/authorization.service.js";
import { verifyMerchant } from "../../src/cli/verify.js";
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
 * INV-11 — the chain claim is only worth what verification proves. `agentkit verify` recomputes
 * every hash from raw rows rather than comparing stored ones, so a row edited in place is
 * caught even when its own hash column was edited to match.
 */
describe("hash chain verification", () => {
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
      velocityPerHour: 1_000,
    });
    await seedCapturedReservation(db.superuser, {
      mandateId,
      amountPaise: 10_000n,
      ageMs: 86_400_000,
    });

    const kernel = testKernel(db.as(ROLES.kernel), MERCHANT_A);
    for (let i = 0; i < 5; i += 1) {
      const quote = await issueQuote(db.superuser, {
        mandateId,
        amountPaise: 12_000n,
        key: quoteKey,
      });
      await authorize(kernel, {
        signedIntent: makeSignedIntent({ agent, mandateId, quote }),
        signedQuote: quote,
      });
    }
  });

  afterAll(async () => {
    await db?.stop();
  });

  it("verifies every chain for the merchant", async () => {
    const report = await verifyMerchant(db.as(ROLES.console), MERCHANT_A);
    expect(report.ok).toBe(true);
    expect(report.chains.length).toBeGreaterThan(0);

    const mandateChain = report.chains.find((c) => c.chainId === mandateId);
    expect(mandateChain?.valid).toBe(true);
    expect(mandateChain?.entries).toBeGreaterThanOrEqual(10);
  });

  it("runs as the read-only console role, so it cannot repair what it finds", async () => {
    // The verifier is evidence, not a maintenance tool.
    await expect(
      withMerchantContext(db.as(ROLES.console), MERCHANT_A, (client) =>
        client.query(`UPDATE ledger SET kind = 'DECISION'`),
      ),
    ).rejects.toThrow();
  });

  it("detects a payload edited in place", async () => {
    // A superuser edit is the strongest attacker we can model at the database layer:
    // RLS, the role grants and the append-only revokes are all bypassed.
    await db.superuser.query(
      `UPDATE ledger SET payload_redacted = jsonb_set(payload_redacted, '{kind}', '"TAMPERED"')
        WHERE chain_id = $1 AND seq = 2`,
      [mandateId],
    );

    const report = await verifyMerchant(db.as(ROLES.console), MERCHANT_A);
    const chain = report.chains.find((c) => c.chainId === mandateId);
    expect(report.ok).toBe(false);
    expect(chain?.valid).toBe(false);
    expect(chain?.brokenAt).toBe(2);
  });

  it("detects a payload edited together with its own hash", async () => {
    // Recomputing from the predecessor is what makes this fail: the edited entry's hash
    // can be made self-consistent, but the next entry's prev_hash still names the old one.
    const original = await db.superuser.query<{ hash: Buffer; payload_redacted: unknown }>(
      `SELECT hash, payload_redacted FROM ledger WHERE chain_id = $1 AND seq = 3`,
      [mandateId],
    );
    expect(original.rows).toHaveLength(1);

    await db.superuser.query(
      `UPDATE ledger
          SET payload_redacted = jsonb_set(payload_redacted, '{ref}', '"forged"'),
              hash = $2
        WHERE chain_id = $1 AND seq = 3`,
      [mandateId, Buffer.alloc(32, 9)],
    );

    const report = await verifyMerchant(db.as(ROLES.console), MERCHANT_A);
    expect(report.ok).toBe(false);
  });
});
