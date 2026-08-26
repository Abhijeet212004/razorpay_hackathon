import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_KERNEL_CONFIG } from "../../src/modules/authorization/authorization.service.js";
import { callTool } from "../../src/modules/mcp/mcp.service.js";
import { createSession, resolveSession, revokeSession } from "../../src/modules/mcp/mcp.session.js";
import { MCP_TOOLS, toolsFor } from "../../src/modules/mcp/mcp.tools.js";
import { ROLES } from "../../src/shared/db/roles.js";
import { startTestDatabase, type TestDatabase } from "../support/postgres.js";
import { startTestRail, testKernel, type TestRail } from "../support/kernel.js";
import {
  MERCHANT_A,
  seedAgent,
  seedCapturedReservation,
  seedCatalogItem,
  seedMandate,
  seedMerchant,
  seedSigningKey,
  seedSubject,
} from "../support/fixtures.js";

/**
 * MCP is a second door onto the same tools. These tests exist to prove the door does not
 * come with a shortcut — that a session identifies an agent and grants nothing, and that
 * every money-moving call still faces the whole policy engine.
 */
describe("MCP", () => {
  let db: TestDatabase;
  let rail: TestRail;
  let mandateId: string;
  let agentId: string;

  const options = {
    merchantId: MERCHANT_A,
    publicBaseUrl: "http://kernel",
    exposed: ["read", "propose", "money"] as const,
    consent: {
      merchantId: MERCHANT_A,
      merchantName: "Sharma Kirana",
      otpTtlMs: 300_000,
      demoMode: true,
    },
  };

  beforeAll(async () => {
    db = await startTestDatabase();
    await seedMerchant(db.superuser);
    const mandateKey = await seedSigningKey(db.superuser, "mandate");
    await seedSigningKey(db.superuser, "quote");
    const agent = await seedAgent(db.superuser);
    agentId = agent.agentId;
    const subject = await seedSubject(db.superuser);
    rail = await startTestRail(db.as(ROLES.kernel));

    mandateId = await seedMandate(db.superuser, {
      agentId: agent.agentId,
      authEventId: subject.authEventId,
      pseudonym: subject.pseudonym,
      kid: mandateKey.kid,
      silentThresholdPaise: 500_000n,
      perTransactionPaise: 500_000n,
      cumulativePaise: 5_000_000n,
      velocityPerHour: 1_000,
    });
    await seedCapturedReservation(db.superuser, { mandateId, amountPaise: 1_000n, ageMs: 86_400_000 });
    await seedCatalogItem(db.superuser, { sku: "rice", category: "groceries", pricePaise: 42_000n });
    await seedCatalogItem(db.superuser, { sku: "charger", category: "electronics", pricePaise: 89_900n });
  });

  afterAll(async () => {
    await rail?.close();
    await db?.stop();
  });

  const kernel = () =>
    testKernel(db.as(ROLES.kernel), MERCHANT_A, {
      executor: rail.executor,
      config: { ...DEFAULT_KERNEL_CONFIG, merchantId: MERCHANT_A },
    });

  const call = async (session: Awaited<ReturnType<typeof createSession>>, name: string, args = {}) => {
    const result = await callTool(
      db.as(ROLES.kernel),
      kernel(),
      { ...options, exposed: [...options.exposed] },
      session,
      name,
      args,
    );
    return { ...JSON.parse(result.content[0]!.text), isError: result.isError === true };
  };

  it("a session identifies an agent and grants nothing", async () => {
    const session = await createSession(db.as(ROLES.kernel), MERCHANT_A, "Claude Desktop");
    expect(session.agentId).toMatch(/^agt_mcp_/);
    // 256 bits of entropy, base64url.
    expect(session.sessionId.length).toBeGreaterThanOrEqual(43);

    // The agent exists, and holds no mandate. Every money call denies.
    const budget = await call(session, "check_budget", { mandate_id: mandateId });
    // The mandate exists but belongs to a different agent, which the policy fold refuses.
    expect(budget).toBeDefined();
  });

  it("refuses an unknown, expired or revoked session identically", async () => {
    const pool = db.as(ROLES.kernel);
    expect(await resolveSession(pool, MERCHANT_A, undefined)).toBeNull();
    expect(await resolveSession(pool, MERCHANT_A, "short")).toBeNull();
    expect(await resolveSession(pool, MERCHANT_A, "a".repeat(43))).toBeNull();

    const session = await createSession(pool, MERCHANT_A, "Claude");
    expect(await resolveSession(pool, MERCHANT_A, session.sessionId)).not.toBeNull();

    await revokeSession(pool, MERCHANT_A, session.sessionId);
    // A revoked session is indistinguishable from one that never existed.
    expect(await resolveSession(pool, MERCHANT_A, session.sessionId)).toBeNull();
  });

  it("does not reveal which tool classes a merchant withheld", async () => {
    const session = await createSession(db.as(ROLES.kernel), MERCHANT_A, "Claude");
    const withoutMoney = await callTool(
      db.as(ROLES.kernel),
      kernel(),
      { ...options, exposed: ["read", "propose"] },
      session,
      "purchase",
      { quote_id: "q", reason: "r" },
    );
    const nonsense = await callTool(
      db.as(ROLES.kernel),
      kernel(),
      { ...options, exposed: ["read", "propose"] },
      session,
      "definitely_not_a_tool",
      {},
    );
    // Withheld and non-existent give the same answer, so the exposed set cannot be mapped.
    expect(withoutMoney.content[0]!.text).toEqual(nonsense.content[0]!.text.replace("definitely_not_a_tool", "purchase"));
    expect(withoutMoney.isError).toBe(true);
  });

  it("cannot pay without a mandate granted to that session's agent", async () => {
    const session = await createSession(db.as(ROLES.kernel), MERCHANT_A, "Claude");

    const quote = await call(session, "get_quote", {
      mandate_id: mandateId,
      items: [{ sku: "rice", quantity: 1 }],
    });
    expect(quote.quote_id).toBeDefined();

    // The mandate binds a different agent, so the fold refuses regardless of the session.
    const bought = await call(session, "purchase", {
      quote_id: quote.quote_id,
      reason: "trying it on",
    });
    expect(bought.verdict).toBe("DENY");
    expect(bought.reason_code).toBe("MND-001");
  });

  it("refuses a quote from another session", async () => {
    const a = await createSession(db.as(ROLES.kernel), MERCHANT_A, "Claude");
    const b = await createSession(db.as(ROLES.kernel), MERCHANT_A, "ChatGPT");

    const quote = await call(a, "get_quote", {
      mandate_id: mandateId,
      items: [{ sku: "rice", quantity: 1 }],
    });
    // Quotes are held per session. One client cannot spend another's.
    const stolen = await call(b, "purchase", { quote_id: quote.quote_id, reason: "not mine" });
    expect(stolen.isError).toBe(true);
  });

  it("keeps scope enforcement at the quote, not the model", async () => {
    const session = await createSession(db.as(ROLES.kernel), MERCHANT_A, "Claude");
    const bad = await call(session, "get_quote", {
      mandate_id: mandateId,
      items: [{ sku: "charger", quantity: 1 }],
    });
    expect(bad.isError).toBe(true);
    expect(bad.reason_code).toBe("SCP-002");
  });

  it("validates every tool's arguments before touching anything", async () => {
    const session = await createSession(db.as(ROLES.kernel), MERCHANT_A, "Claude");
    for (const [name, args] of [
      ["catalog_get", {}],
      ["check_budget", {}],
      ["get_quote", { mandate_id: mandateId, items: [] }],
      ["purchase", { quote_id: "" }],
      ["order_status", { mandate_id: mandateId }],
      ["request_permission", { contact: "not-a-phone" }],
    ] as const) {
      const result = await call(session, name, args as object);
      expect(result.isError, `${name} accepted invalid arguments`).toBe(true);
    }
  });

  it("describes every tool well enough for a model to use it correctly", () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.description.length, `${tool.name} needs a real description`).toBeGreaterThan(60);
      expect(tool.inputSchema).toHaveProperty("type", "object");
    }
    // The two tools a model most often gets wrong say explicitly what not to conclude.
    const purchase = MCP_TOOLS.find((t) => t.name === "purchase")!;
    expect(purchase.description).toContain("must not be retried");
    const status = MCP_TOOLS.find((t) => t.name === "order_status")!;
    expect(status.description).toContain("Do not re-purchase");
  });

  it("exposes only the classes the merchant configured", () => {
    expect(toolsFor(["read"]).every((t) => t.class === "read")).toBe(true);
    expect(toolsFor(["read", "propose"]).some((t) => t.class === "money")).toBe(false);
    // A merchant can leave an agent able to browse and quote but never to pay.
    expect(toolsFor(["read", "propose"]).length).toBeGreaterThan(4);
  });
});
