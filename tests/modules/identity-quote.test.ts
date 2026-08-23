/** INV-06, INV-14, INV-16 — identity, key rotation, and quote binding. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  QuoteOutOfScopeError,
  UnknownSkuError,
  basketHash,
  priceBasket,
  verifySignature,
} from "../../src/modules/quote/quote.service.js";
import {
  isAuthEventFresh,
  registerAgent,
  recordAuthEvent,
  rotateSigningKey,
} from "../../src/modules/identity/identity.service.js";
import { findVerificationKey } from "../../src/modules/identity/identity.repository.js";
import { generateKeyPair } from "../../src/shared/crypto/ed25519.js";
import { ROLES } from "../../src/shared/db/roles.js";
import { SQLSTATE, sqlstateFrom, startTestDatabase, type TestDatabase } from "../support/postgres.js";
import {
  MERCHANT_A,
  seedAgent,
  seedCatalogItem,
  seedMandate,
  seedMerchant,
  seedSigningKey,
  seedSubject,
} from "../support/fixtures.js";

describe("identity", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
    await seedMerchant(db.superuser);
  });
  afterAll(async () => {
    await db?.stop();
  });

  it("registers an agent as identity only, never authority", async () => {
    const { publicKey } = generateKeyPair();
    const { agentId, attestation } = await registerAgent(db.as(ROLES.kernel), {
      name: "ShopBuddy",
      public_key: publicKey.toString("hex"),
    });

    expect(agentId).toMatch(/^agt_/);
    expect(attestation).toBe("self_registered_v1");

    // Registration grants nothing: the agent holds no mandate, so every money call still
    // denies. That is what lets this endpoint stay open with no partnership call.
    const mandates = await db.superuser.query(`SELECT 1 FROM mandates WHERE agent_id = $1`, [
      agentId,
    ]);
    expect(mandates.rowCount).toBe(0);
  });

  it("records an auth event and can tell whether it is still fresh", async () => {
    const { authEventId } = await recordAuthEvent(db.as(ROLES.kernel), {
      subject_pseudonym: "psu_fresh",
      method: "sms_otp",
      max_age_seconds: 300,
    });

    const pool = db.as(ROLES.kernel);
    expect(await isAuthEventFresh(pool, authEventId, new Date())).toBe(true);
    expect(await isAuthEventFresh(pool, authEventId, new Date(Date.now() + 400_000))).toBe(false);
  });

  it("rotates a signing key by retiring the old one, never deleting it", async () => {
    const pool = db.superuser;
    const first = await rotateSigningKey(pool, "catalog");
    expect(first.retired).toBeNull();

    const second = await rotateSigningKey(pool, "catalog");
    expect(second.retired).toBe(first.kid);

    // Verification must keep accepting signatures the retired key already made.
    expect((await findVerificationKey(pool, first.kid))?.state).toBe("retired");
    expect((await findVerificationKey(pool, second.kid))?.state).toBe("active");
  });

  it("cannot have two active keys for one purpose", async () => {
    const { publicKey } = generateKeyPair();
    const code = await sqlstateFrom(() =>
      db.superuser.query(
        `INSERT INTO signing_keys (kid, purpose, state, public_key)
         VALUES ('kid_dupe_catalog', 'catalog', 'active', $1)`,
        [publicKey],
      ),
    );
    expect(code).toBe(SQLSTATE.UNIQUE_VIOLATION);
  });
});

describe("quotes", () => {
  let db: TestDatabase;
  let mandateId: string;
  let narrowMandateId: string;

  const options = { merchantId: MERCHANT_A, quoteTtlMs: 600_000 };

  beforeAll(async () => {
    db = await startTestDatabase();
    await seedMerchant(db.superuser);

    const mandateKey = await seedSigningKey(db.superuser, "mandate");
    await seedSigningKey(db.superuser, "quote");
    const agent = await seedAgent(db.superuser);
    const subject = await seedSubject(db.superuser);

    mandateId = await seedMandate(db.superuser, {
      agentId: agent.agentId,
      authEventId: subject.authEventId,
      pseudonym: subject.pseudonym,
      kid: mandateKey.kid,
      allowedCategories: ["groceries", "household"],
    });
    narrowMandateId = await seedMandate(db.superuser, {
      agentId: agent.agentId,
      authEventId: subject.authEventId,
      pseudonym: subject.pseudonym,
      kid: mandateKey.kid,
      allowedCategories: ["household"],
    });

    await seedCatalogItem(db.superuser, { sku: "rice-5kg", category: "groceries", pricePaise: 42_000n });
    await seedCatalogItem(db.superuser, { sku: "milk-1l", category: "groceries", pricePaise: 6_400n });
    await seedCatalogItem(db.superuser, { sku: "charger", category: "electronics", pricePaise: 89_900n });
  });

  afterAll(async () => {
    await db?.stop();
  });

  it("prices the basket from the merchant's catalog, not from the request", async () => {
    const signed = await priceBasket(db.as(ROLES.kernel), options, {
      mandateId,
      items: [
        { sku: "rice-5kg", quantity: 1 },
        { sku: "milk-1l", quantity: 2 },
      ],
    });

    // 42000 + 2 x 6400. The agent supplied quantities; every price came from the catalog.
    expect(signed.quote.amount_paise).toBe(54_800n);
    expect(signed.quote.mandate_id).toBe(mandateId);
    expect(signed.quote.categories).toEqual(["groceries"]);
    expect(await verifySignature(db.as(ROLES.kernel), signed)).toBe(true);
  });

  it("refuses to issue a quote outside the mandate's scope", async () => {
    // Ergonomics, not enforcement: it fails fast so the agent never builds an intent
    // around a basket the policy engine would deny under the lock anyway.
    await expect(
      priceBasket(db.as(ROLES.kernel), options, {
        mandateId: narrowMandateId,
        items: [{ sku: "rice-5kg", quantity: 1 }],
      }),
    ).rejects.toThrow(QuoteOutOfScopeError);
  });

  it("refuses an unknown sku rather than pricing it as zero", async () => {
    await expect(
      priceBasket(db.as(ROLES.kernel), options, {
        mandateId,
        items: [{ sku: "does-not-exist", quantity: 1 }],
      }),
    ).rejects.toThrow(UnknownSkuError);
  });

  it("hashes a basket independently of the order it was listed in", () => {
    const a = basketHash([
      { sku: "milk-1l", quantity: 2, pricePaise: 6_400n },
      { sku: "rice-5kg", quantity: 1, pricePaise: 42_000n },
    ]);
    const b = basketHash([
      { sku: "rice-5kg", quantity: 1, pricePaise: 42_000n },
      { sku: "milk-1l", quantity: 2, pricePaise: 6_400n },
    ]);
    expect(a.equals(b)).toBe(true);

    const different = basketHash([
      { sku: "rice-5kg", quantity: 2, pricePaise: 42_000n },
      { sku: "milk-1l", quantity: 2, pricePaise: 6_400n },
    ]);
    expect(a.equals(different)).toBe(false);
  });

  it("rejects a quote signature made by a key of another purpose", async () => {
    const signed = await priceBasket(db.as(ROLES.kernel), options, {
      mandateId,
      items: [{ sku: "milk-1l", quantity: 1 }],
    });
    expect(await verifySignature(db.as(ROLES.kernel), { ...signed, kid: "kid_nope" })).toBe(false);
  });
});
