import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  onboard,
  read,
  resolveByApiKey,
  resolveByFulfilToken,
} from "../../src/modules/merchant/merchant.repository.js";
import { ROLES } from "../../src/shared/db/roles.js";
import { startTestDatabase, withMerchantContext, type TestDatabase } from "../support/postgres.js";

/**
 * Many merchants on one kernel.
 *
 * The credential decides the tenant. An agent presenting a key gets exactly one
 * merchant's catalogue, limits and money — and there is no field anywhere that lets it
 * ask for a different one.
 */
describe("the merchant registry", () => {
  let db: TestDatabase;
  let alpha: Awaited<ReturnType<typeof onboard>>;
  let beta: Awaited<ReturnType<typeof onboard>>;

  beforeAll(async () => {
    db = await startTestDatabase();
    const pool = db.as(ROLES.kernel);
    alpha = await onboard(pool, {
      display_name: "Alpha Stores",
      catalog_url: "https://alpha.test/products",
      public_base_url: "https://alpha.test",
    });
    beta = await onboard(pool, {
      display_name: "Beta Bazaar",
      catalog_url: "https://beta.test/products",
      public_base_url: "https://beta.test",
    });
  });
  afterAll(async () => { await db?.stop(); });

  it("gives each merchant a distinct id and distinct credentials", () => {
    expect(alpha.merchantId).not.toBe(beta.merchantId);
    expect(alpha.apiKey).not.toBe(beta.apiKey);
    expect(alpha.fulfilToken).not.toBe(beta.fulfilToken);
  });

  it("resolves a key to exactly its own merchant", async () => {
    const pool = db.as(ROLES.kernel);
    expect(await resolveByApiKey(pool, alpha.apiKey)).toEqual({
      kind: "RESOLVED", merchantId: alpha.merchantId,
    });
    expect(await resolveByApiKey(pool, beta.apiKey)).toEqual({
      kind: "RESOLVED", merchantId: beta.merchantId,
    });
  });

  it("refuses a credential it has never seen", async () => {
    const pool = db.as(ROLES.kernel);
    for (const junk of ["", "ak_nonsense", alpha.apiKey.slice(0, -1), "null"]) {
      expect(await resolveByApiKey(pool, junk)).toEqual({ kind: "UNKNOWN" });
    }
  });

  it("keeps the agent key and the merchant's own token separate", async () => {
    const pool = db.as(ROLES.kernel);
    // Leaking one must not grant the other's reach.
    expect(await resolveByFulfilToken(pool, alpha.apiKey)).toEqual({ kind: "UNKNOWN" });
    expect(await resolveByApiKey(pool, alpha.fulfilToken)).toEqual({ kind: "UNKNOWN" });
    expect(await resolveByFulfilToken(pool, alpha.fulfilToken)).toEqual({
      kind: "RESOLVED", merchantId: alpha.merchantId,
    });
  });

  it("stores no credential that could be presented back", async () => {
    const row = await db.superuser.query<{ api_key_hash: Buffer; fulfil_token_hash: Buffer }>(
      `SELECT api_key_hash, fulfil_token_hash FROM merchants WHERE merchant_id = $1`,
      [alpha.merchantId],
    );
    const stored = row.rows[0]!;
    expect(stored.api_key_hash.length).toBe(32);
    expect(stored.api_key_hash.toString("utf8")).not.toContain(alpha.apiKey);
    expect(stored.fulfil_token_hash.toString("utf8")).not.toContain(alpha.fulfilToken);
  });

  it("shows a merchant only its own row", async () => {
    const pool = db.as(ROLES.kernel);
    const own = await withMerchantContext(pool, alpha.merchantId, (c) => read(c, alpha.merchantId));
    expect(own?.displayName).toBe("Alpha Stores");

    // Alpha's context, Beta's id: row level security answers with nothing.
    const other = await withMerchantContext(pool, alpha.merchantId, (c) => read(c, beta.merchantId));
    expect(other).toBeNull();
  });

  it("stops a suspended merchant without deleting anything", async () => {
    const pool = db.as(ROLES.kernel);
    await db.superuser.query(
      `UPDATE merchants SET state = 'suspended', suspended_at = now() WHERE merchant_id = $1`,
      [beta.merchantId],
    );
    expect(await resolveByApiKey(pool, beta.apiKey)).toEqual({
      kind: "SUSPENDED", merchantId: beta.merchantId,
    });
    // Alpha is untouched: suspension is per tenant, not a kill switch for the kernel.
    expect(await resolveByApiKey(pool, alpha.apiKey)).toEqual({
      kind: "RESOLVED", merchantId: alpha.merchantId,
    });
  });
});
