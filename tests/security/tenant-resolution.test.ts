import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { onboard } from "../../src/modules/merchant/merchant.repository.js";
import {
  refusal,
  resolveAgentTenant,
  resolveMerchantTenant,
} from "../../src/modules/merchant/merchant.tenant.js";
import { ROLES } from "../../src/shared/db/roles.js";
import { startTestDatabase, type TestDatabase } from "../support/postgres.js";
import type { RequestContext } from "../../src/shared/http.js";

/**
 * Which merchant a request belongs to is decided by a credential, never by the request.
 *
 * If an agent could name a merchant it would be choosing whose limits bind it. These
 * tests exist to make that impossible to reintroduce: there is no header, body field or
 * query parameter here that carries a merchant id inward.
 */
function ctx(headers: Record<string, string>): RequestContext {
  return {
    method: "POST",
    path: "/agent/quote",
    query: new URLSearchParams(),
    params: {},
    headers,
    rawBody: "",
  };
}

describe("resolving the tenant", () => {
  let db: TestDatabase;
  let alpha: Awaited<ReturnType<typeof onboard>>;
  let beta: Awaited<ReturnType<typeof onboard>>;
  let hosted: { pool: ReturnType<TestDatabase["as"]>; defaultMerchantId: null };
  let single: { pool: ReturnType<TestDatabase["as"]>; defaultMerchantId: string };

  beforeAll(async () => {
    db = await startTestDatabase();
    const pool = db.as(ROLES.kernel);
    alpha = await onboard(pool, {
      display_name: "Alpha", catalog_url: "https://a.test/p", public_base_url: "https://a.test",
    });
    beta = await onboard(pool, {
      display_name: "Beta", catalog_url: "https://b.test/p", public_base_url: "https://b.test",
    });
    hosted = { pool, defaultMerchantId: null };
    single = { pool, defaultMerchantId: alpha.merchantId };
  });
  afterAll(async () => { await db?.stop(); });

  it("resolves a Bearer key to its own merchant", async () => {
    expect(await resolveAgentTenant(hosted, ctx({ authorization: `Bearer ${alpha.apiKey}` })))
      .toEqual({ kind: "TENANT", merchantId: alpha.merchantId });
    expect(await resolveAgentTenant(hosted, ctx({ authorization: `Bearer ${beta.apiKey}` })))
      .toEqual({ kind: "TENANT", merchantId: beta.merchantId });
  });

  it("accepts the header form too", async () => {
    expect(await resolveAgentTenant(hosted, ctx({ "x-agentkit-key": beta.apiKey })))
      .toEqual({ kind: "TENANT", merchantId: beta.merchantId });
  });

  it("resolves to nobody when hosted and no credential is presented", async () => {
    expect(await resolveAgentTenant(hosted, ctx({}))).toEqual({ kind: "NO_CREDENTIAL" });
  });

  it("falls back to the configured merchant only when one is configured", async () => {
    // Self-hosted and demo deployments serve exactly one merchant and need no key.
    expect(await resolveAgentTenant(single, ctx({})))
      .toEqual({ kind: "TENANT", merchantId: alpha.merchantId });
  });

  it("cannot be told which merchant to be", async () => {
    // Every shape someone might try to smuggle a tenant in through.
    for (const headers of [
      { "x-merchant-id": beta.merchantId },
      { "x-agentkit-merchant": beta.merchantId },
      { authorization: `Bearer ${alpha.apiKey}`, "x-merchant-id": beta.merchantId },
    ]) {
      const outcome = await resolveAgentTenant(single, ctx(headers));
      // Either nobody, or the merchant the *credential* names — never the one asked for.
      if (outcome.kind === "TENANT") expect(outcome.merchantId).toBe(alpha.merchantId);
    }
  });

  it("keeps the agent key and the merchant token on separate doors", async () => {
    expect(await resolveMerchantTenant(hosted, ctx({ "x-agentkit-token": alpha.apiKey })))
      .toEqual({ kind: "UNKNOWN_CREDENTIAL" });
    expect(await resolveMerchantTenant(hosted, ctx({ "x-agentkit-token": alpha.fulfilToken })))
      .toEqual({ kind: "TENANT", merchantId: alpha.merchantId });
  });

  it("refuses a suspended merchant without pretending they are unknown", async () => {
    await db.superuser.query(
      `UPDATE merchants SET state = 'suspended' WHERE merchant_id = $1`, [beta.merchantId]);
    const outcome = await resolveAgentTenant(hosted, ctx({ authorization: `Bearer ${beta.apiKey}` }));
    expect(outcome).toEqual({ kind: "SUSPENDED", merchantId: beta.merchantId });
    expect(refusal(outcome as never).status).toBe(403);
  });

  it("tells a wrong key and a missing key exactly the same thing", async () => {
    // Otherwise the endpoint is an oracle for guessing keys.
    const wrong = refusal(await resolveAgentTenant(hosted, ctx({ authorization: "Bearer ak_wrong" })) as never);
    const missing = refusal(await resolveAgentTenant(hosted, ctx({})) as never);
    expect(wrong).toEqual(missing);
  });
});
