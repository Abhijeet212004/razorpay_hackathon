import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  resolveActiveMerchant,
  resolveByConsentRef,
  resolveByMandate,
  handoffKey,
} from "../../src/modules/merchant/merchant.repository.js";
import { ROLES } from "../../src/shared/db/roles.js";
import { startTestDatabase, type TestDatabase } from "../support/postgres.js";
import {
  MERCHANT_A,
  MERCHANT_B,
  seedAgent,
  seedMandate,
  seedMerchant,
  seedSigningKey,
  seedSubject,
} from "../support/fixtures.js";

/**
 * A shopper holds a reference, never a credential.
 *
 * Every shopper-facing route used to resolve its tenant through the agent door, which
 * reads an API key. A browser has none, so those routes fell back to MERCHANT_ID: on a
 * single-tenant deployment they guessed right because there was one merchant to guess,
 * and on a hosted one, which sets no default, they answered 404 to every shopper.
 *
 * The reference decides the tenant instead. These resolvers run as the kernel role with no
 * tenant context set, which is the situation they exist for: they are what establishes the
 * context, so they cannot depend on it already being there.
 */
describe("tenancy resolved from a reference rather than a credential", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
    await seedMerchant(db.superuser, MERCHANT_A);
    await seedMerchant(db.superuser, MERCHANT_B, "Other Store");
  });

  afterAll(async () => {
    await db.stop();
  });

  it("a mandate resolves to the merchant that owns it, with no context set", async () => {
    const kernel = db.as(ROLES.kernel);
    const agent = await seedAgent(db.superuser);
    const subject = await seedSubject(db.superuser);
    const key = await seedSigningKey(db.superuser, "mandate");
    const mandateId = await seedMandate(db.superuser, {
      agentId: agent.agentId,
      authEventId: subject.authEventId,
      pseudonym: subject.pseudonym,
      kid: key.kid,
      merchantId: MERCHANT_B,
    });

    const outcome = await resolveByMandate(kernel, mandateId);
    expect(outcome).toEqual({ kind: "RESOLVED", merchantId: MERCHANT_B });
  });

  it("a reference nobody owns resolves to nobody, not to the first merchant", async () => {
    const kernel = db.as(ROLES.kernel);
    expect(await resolveByMandate(kernel, `mnd_${randomUUID()}`)).toEqual({ kind: "UNKNOWN" });
    expect(await resolveByConsentRef(kernel, `creq_${randomUUID()}`)).toEqual({ kind: "UNKNOWN" });
    // The empty string is the shape a missing path parameter arrives as.
    expect(await resolveByConsentRef(kernel, "")).toEqual({ kind: "UNKNOWN" });
  });

  it("a merchant id confirms existence and nothing else", async () => {
    const kernel = db.as(ROLES.kernel);
    expect(await resolveActiveMerchant(kernel, MERCHANT_A)).toEqual({
      kind: "RESOLVED",
      merchantId: MERCHANT_A,
    });
    expect(await resolveActiveMerchant(kernel, "mch_never_existed")).toEqual({ kind: "UNKNOWN" });
  });

  it("the handoff key is readable without tenant context, and is per merchant", async () => {
    const kernel = db.as(ROLES.kernel);
    const hash = (s: string) => createHash("sha256").update(s, "utf8").digest();

    await db.superuser.query(`UPDATE merchants SET fulfil_token_hash = $2 WHERE merchant_id = $1`, [
      MERCHANT_A,
      hash("aft_merchant_a"),
    ]);
    await db.superuser.query(`UPDATE merchants SET fulfil_token_hash = $2 WHERE merchant_id = $1`, [
      MERCHANT_B,
      hash("aft_merchant_b"),
    ]);

    // merchants is under forced row level security. A plain query here returns nothing and
    // silently falls back to the wrong key, which is exactly the bug this guards.
    const keyA = await handoffKey(kernel, MERCHANT_A);
    const keyB = await handoffKey(kernel, MERCHANT_B);

    expect(keyA).toBe(hash("aft_merchant_a").toString("hex"));
    expect(keyB).toBe(hash("aft_merchant_b").toString("hex"));
    expect(keyA).not.toBe(keyB);
  });

  it("a merchant with no token issued has no key, so the caller can fall back", async () => {
    const kernel = db.as(ROLES.kernel);
    await db.superuser.query(`UPDATE merchants SET fulfil_token_hash = NULL WHERE merchant_id = $1`, [
      MERCHANT_A,
    ]);
    expect(await handoffKey(kernel, MERCHANT_A)).toBeNull();
  });
});
