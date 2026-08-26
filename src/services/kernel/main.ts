import { authorize, DEFAULT_KERNEL_CONFIG } from "../../modules/authorization/authorization.service.js";
import { AuthorizationRequestSchema } from "../../modules/authorization/authorization.validation.js";
import { createExecutorHttpClient } from "../../modules/executor/executor.client.js";
import {
  QuoteOutOfScopeError,
  UnknownSkuError,
  priceBasket,
} from "../../modules/quote/quote.service.js";
import { registerAgent } from "../../modules/identity/identity.service.js";
import { approveStepUp } from "../../modules/authorization/authorization.service.js";
import { findChallenge } from "../../modules/authorization/authorization.repository.js";
import {
  consentStatus,
  readConsentRequest,
  requestConsent,
  sendOtp,
  verifyAndGrant,
} from "../../modules/consent/consent.service.js";
import { RequestConsentSchema } from "../../modules/consent/consent.validation.js";
import { consentPage, resultPage, stepUpPage } from "../../modules/consent/consent.pages.js";
import { setMerchantContext } from "../../shared/db/merchant-context.js";
import * as console_ from "../../modules/console/console.repository.js";
import * as catalog from "../../modules/catalog/catalog.service.js";
import { CatalogSearchSchema } from "../../modules/catalog/catalog.validation.js";
import * as orders from "../../modules/orders/orders.service.js";
import { toolManifest } from "../../modules/agent/agent.tools.js";
import { handleMcp } from "../../modules/mcp/mcp.controller.js";
import type { ToolClass } from "../../modules/agent/agent.tools.js";
import { ingestWebhook } from "../../modules/reconciler/reconciler.service.js";
import { createHttpRail } from "../../modules/rail/rail.http.js";
import { scriptedVerifier } from "../../modules/verifier/verifier.service.js";
import { assertNoPaymentCredential } from "../../shared/credentials.js";
import { loadConfig, poolFor } from "../../shared/config.js";
import { ROLES } from "../../shared/db/roles.js";
import { createHttpService, listen } from "../../shared/http.js";
import { consoleLogger } from "../../shared/logger.js";
import { systemClock } from "../../shared/clock.js";

/**
 * The kernel. Public HTTP, no payment credential.
 *
 * The assertion below runs before anything else: a credential merely present in this
 * process would break the claim the whole design rests on, so the service refuses to
 * boot rather than running in a state it cannot honestly describe.
 */
assertNoPaymentCredential("kernel");

const config = loadConfig();
const pool = poolFor(ROLES.kernel);

const executor = createExecutorHttpClient({
  baseUrl: config.executorUrl,
  token: config.executorToken,
});

const rail = createHttpRail({
  mode: config.rail,
  baseUrl: config.railBaseUrl,
  // The kernel reads order state to reconcile. It cannot create a payment: these are not
  // a credential, and the rail rejects them for anything that moves money.
  keyId: process.env.RZP_READ_KEY_ID ?? "rzp_test_replay",
  keySecret: process.env.RZP_READ_KEY_SECRET ?? "replay-has-no-real-secret",
  timeoutMs: 8000,
});

const kernel = {
  pool,
  verifier: scriptedVerifier(),
  clock: systemClock,
  logger: consoleLogger,
  executor,
  config: { ...DEFAULT_KERNEL_CONFIG, merchantId: config.merchantId },
};

const HTML = { "Content-Type": "text/html; charset=utf-8" };

const consentOptions = {
  merchantId: config.merchantId,
  merchantName: process.env.MERCHANT_NAME ?? "Sharma Kirana",
  otpTtlMs: 5 * 60_000,
  demoMode: process.env.CONSENT_DEMO_MODE !== "false",
};

/** Parses an HTML form body without pulling in a framework to do it. */
function form(raw: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(raw).entries());
}

/**
 * Which tool classes this merchant exposes over MCP. `money` can be withheld entirely,
 * which leaves an agent able to browse and quote but never to pay.
 */
const exposedClasses = (process.env.MCP_EXPOSE ?? "read,propose,money")
  .split(",")
  .map((c) => c.trim())
  .filter((c): c is ToolClass => ["read", "propose", "money", "margin"].includes(c));

const mcp = {
  pool,
  kernel,
  options: {
    merchantId: config.merchantId,
    publicBaseUrl: config.publicBaseUrl,
    exposed: exposedClasses,
    consent: consentOptions,
    logger: consoleLogger,
  },
};

const server = createHttpService([
  {
    method: "GET",
    path: "/health",
    handler: async () => {
      await pool.query("SELECT 1");
      return {
        status: 200,
        body: {
          ok: true,
          service: "kernel",
          // Never let a viewer mistake replay for live.
          mode: { rail: config.rail, brain: config.brain, verifier: config.verifier },
        },
      };
    },
  },
  {
    method: "GET",
    path: "/.well-known/agent-commerce.json",
    handler: () => ({
      status: 200,
      body: {
        merchant_id: config.merchantId,
        transports: ["mcp", "acp", "http"],
        mcp: `${config.publicBaseUrl}/agent/mcp`,
        // One hop from discovery to the full tool surface.
        tools: `${config.publicBaseUrl}/agent/tools`,
        register_url: `${config.publicBaseUrl}/agent/register`,
        grant_url: `${config.publicBaseUrl}/consent/request`,
        mandate: { shape: "policy-mandate/v1", currency: "INR" },
      },
    }),
  },
  {
    method: "POST",
    path: "/agent/register",
    handler: async (ctx) => {
      const body = JSON.parse(ctx.rawBody) as { name: string; public_key: string };
      const result = await registerAgent(pool, body);
      // Identity, not authority. Every money call still denies until a mandate exists.
      return { status: 201, body: { agent_id: result.agentId, attestation: result.attestation } };
    },
  },
  {
    // MCP over Streamable HTTP. A second door onto the same tools, and the same gate.
    method: "POST",
    path: "/agent/mcp",
    handler: (ctx) => handleMcp(mcp, ctx),
  },
  {
    // The tool manifest. An agent that cannot discover the tools cannot use them.
    method: "GET",
    path: "/agent/tools",
    handler: () => ({ status: 200, body: toolManifest(config.publicBaseUrl) }),
  },
  {
    method: "POST",
    path: "/agent/catalog/search",
    handler: async (ctx) => {
      const raw = JSON.parse(ctx.rawBody) as { mandate_id?: string };
      const parsed = CatalogSearchSchema.safeParse(raw);
      if (!parsed.success) return { status: 400, body: { error: "invalid_request" } };

      const result = await catalog.search(
        pool,
        { merchantId: config.merchantId },
        parsed.data,
        raw.mandate_id,
      );
      return { status: 200, body: result };
    },
  },
  {
    method: "GET",
    path: "/agent/catalog/:sku",
    handler: async (ctx) => {
      const item = await catalog.getItem(
        pool,
        { merchantId: config.merchantId },
        ctx.params.sku ?? "",
        ctx.query.get("mandate_id") ?? undefined,
      );
      return item === null
        ? { status: 404, body: { error: "unknown_sku", recoverable: true } }
        : { status: 200, body: item };
    },
  },
  {
    method: "GET",
    path: "/agent/mandate/:mandate_id",
    handler: async (ctx) => {
      const view = await orders.spendRemaining(
        pool,
        { merchantId: config.merchantId },
        ctx.params.mandate_id ?? "",
      );
      // An unknown mandate and a mandate belonging to another merchant are the same
      // answer on purpose: row level security makes them indistinguishable here.
      return view === null
        ? { status: 404, body: { error: "unknown_mandate", reason_code: "MND-001" } }
        : { status: 200, body: view };
    },
  },
  {
    method: "POST",
    path: "/agent/orders/history",
    handler: async (ctx) => {
      const body = JSON.parse(ctx.rawBody) as { mandate_id?: string; limit?: number };
      if (body.mandate_id === undefined) {
        return { status: 400, body: { error: "mandate_id is required" } };
      }
      const list = await orders.history(
        pool,
        { merchantId: config.merchantId },
        body.mandate_id,
        body.limit ?? 20,
      );
      return { status: 200, body: { orders: list } };
    },
  },
  {
    method: "POST",
    path: "/agent/orders/status",
    handler: async (ctx) => {
      const body = JSON.parse(ctx.rawBody) as { mandate_id?: string; intent_id?: string };
      if (body.mandate_id === undefined || body.intent_id === undefined) {
        return { status: 400, body: { error: "mandate_id and intent_id are required" } };
      }
      const view = await orders.status(
        pool,
        { merchantId: config.merchantId },
        body.mandate_id,
        body.intent_id,
      );
      return view === null
        ? { status: 404, body: { error: "unknown_order" } }
        : { status: 200, body: view };
    },
  },
  {
    method: "POST",
    path: "/agent/orders/reorder",
    handler: async (ctx) => {
      const body = JSON.parse(ctx.rawBody) as { mandate_id?: string; intent_id?: string };
      if (body.intent_id === undefined) {
        return { status: 400, body: { error: "intent_id is required" } };
      }
      const items = await orders.reorderBasket(
        pool,
        { merchantId: config.merchantId },
        body.intent_id,
      );
      // Line items only. Quoting them again is a separate call, and it faces every
      // check from scratch — yesterday's approval buys nothing today.
      return {
        status: 200,
        body: { items, note: "quote these again; the price and your limits are checked afresh" },
      };
    },
  },
  {
    method: "POST",
    path: "/agent/orders/cancel",
    handler: async (ctx) => {
      const body = JSON.parse(ctx.rawBody) as { mandate_id?: string; intent_id?: string };
      if (body.mandate_id === undefined || body.intent_id === undefined) {
        return { status: 400, body: { error: "mandate_id and intent_id are required" } };
      }
      const outcome = await orders.cancel(
        pool,
        { merchantId: config.merchantId },
        body.mandate_id,
        body.intent_id,
      );
      const status =
        outcome.kind === "CANCELLED" ? 200 : outcome.kind === "NOT_FOUND" ? 404 : 409;
      return { status, body: outcome };
    },
  },
  {
    method: "POST",
    path: "/agent/quote",
    handler: async (ctx) => {
      const body = JSON.parse(ctx.rawBody) as {
        mandate_id: string;
        items: Array<{ sku: string; quantity: number }>;
      };
      try {
        const quote = await priceBasket(
          pool,
          { merchantId: config.merchantId, quoteTtlMs: DEFAULT_KERNEL_CONFIG.quoteTtlMs },
          { mandateId: body.mandate_id, items: body.items },
        );
        return {
          status: 200,
          body: {
            ...quote,
            quote: { ...quote.quote, amount_paise: quote.quote.amount_paise.toString() },
          },
        };
      } catch (error) {
        // A basket we will not price is the caller's problem, not a server fault. The
        // agent is told what to do about it, and never why the item was held back.
        if (error instanceof UnknownSkuError) {
          return {
            status: 404,
            body: {
              error: "unknown_sku",
              explanation: "I can't find that item.",
              recoverable: true,
              skus: error.skus,
            },
          };
        }
        if (error instanceof QuoteOutOfScopeError) {
          return {
            status: 403,
            body: {
              error: "out_of_scope",
              reason_code: "SCP-002",
              explanation: `I can't buy that — your permission covers ${error.allowed.join(" and ")}.`,
              recoverable: true,
              suggested_actions: ["widen_scope", "choose_another_item"],
            },
          };
        }
        return { status: 400, body: { error: "cannot_quote", recoverable: false } };
      }
    },
  },
  {
    method: "POST",
    path: "/agent/acp/checkout",
    handler: async (ctx) => {
      const parsed = AuthorizationRequestSchema.safeParse(JSON.parse(ctx.rawBody));
      if (!parsed.success) return { status: 400, body: { error: "invalid_request" } };

      const decision = await authorize(kernel, parsed.data);

      // A denial is a 200 with a verdict, not an error. The agent is being told the
      // outcome of a decision, not that its request was malformed.
      return {
        status: 200,
        body: {
          verdict: decision.verdict,
          reason_code: decision.reason_code,
          intent_id: decision.intent_id,
          // Present only on STEP_UP: the single-use challenge bound to this intent.
          challenge_id: decision.challenge_id,
          approval_url:
            decision.challenge_id === null
              ? null
              : `${config.publicBaseUrl}/agent/approve/${decision.challenge_id}`,
          audit_url: `${config.publicBaseUrl}/agent/audit/${decision.intent_id}`,
          ...explain(decision.reason_code),
        },
      };
    },
  },
  {
    method: "POST",
    path: "/agent/webhooks/razorpay",
    handler: async (ctx) => {
      const signature = ctx.headers["x-razorpay-signature"];
      const outcome = await ingestWebhook(
        {
          pool,
          rail,
          webhookSecret: config.webhookSecret,
          merchantId: config.merchantId,
          logger: consoleLogger,
        },
        ctx.rawBody,
        typeof signature === "string" ? signature : undefined,
      );
      // An unverified event gets a 401; a duplicate gets a 200, because the sender did
      // nothing wrong and retrying would not help.
      return outcome.kind === "UNVERIFIED"
        ? { status: 401, body: { error: "signature_invalid" } }
        : { status: 200, body: outcome };
    },
  },
  {
    // Read-only agent activity, for the merchant's own admin. The console role is
    // SELECT-only and row level security scoped, so this cannot write history or read
    // another merchant's.
    method: "GET",
    path: "/console/:view",
    handler: async (ctx) => {
      const merchant = config.merchantId;
      switch (ctx.params.view) {
        case "summary": {
          const [decisions, mandates, denials, quarantined] = await Promise.all([
            console_.recentDecisions(pool, merchant, 60),
            console_.mandates(pool, merchant),
            console_.denialCounts(pool, merchant),
            console_.quarantined(pool, merchant),
          ]);
          return {
            status: 200,
            body: {
              mode: { rail: config.rail, brain: config.brain, verifier: config.verifier },
              decisions: decisions.map((d) => ({
                ...d,
                createdAt: d.createdAt.toISOString(),
              })),
              mandates: mandates.map((m) => ({ ...m, notAfter: m.notAfter.toISOString() })),
              denials,
              quarantined,
            },
          };
        }
        case "trace": {
          const intentId = ctx.query.get("intent_id") ?? "";
          const entries = await console_.trace(pool, merchant, intentId);
          return {
            status: 200,
            body: {
              intentId,
              entries: entries.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
            },
          };
        }
        default:
          return { status: 404, body: { error: "unknown_view" } };
      }
    },
  },
  {
    method: "POST",
    path: "/consent/request",
    handler: async (ctx) => {
      const parsed = RequestConsentSchema.safeParse(JSON.parse(ctx.rawBody));
      if (!parsed.success) return { status: 400, body: { error: "invalid_request" } };
      const { requestRef } = await requestConsent(pool, consentOptions, parsed.data);
      // A reference, never a grant.
      return {
        status: 202,
        body: {
          request_ref: requestRef,
          consent_url: `${config.publicBaseUrl}/consent/${requestRef}`,
        },
      };
    },
  },
  {
    // How an agent learns whether it was permitted, without reading the human's screen.
    method: "GET",
    path: "/consent/:ref/status",
    handler: async (ctx) => {
      const status = await consentStatus(pool, consentOptions, ctx.params.ref ?? "");
      return status === null
        ? { status: 404, body: { error: "unknown_request" } }
        : {
            status: 200,
            body: {
              state: status.state,
              granted: status.state === "granted",
              mandate_id: status.mandateId,
            },
          };
    },
  },
  {
    method: "GET",
    path: "/consent/:ref",
    handler: async (ctx) => {
      const view = await readConsentRequest(pool, consentOptions, ctx.params.ref ?? "");
      if (view === null) {
        return { status: 404, body: resultPage("Not found", "That link has expired or never existed.") };
      }
      if (view.state === "granted") {
        return { status: 200, body: resultPage("Already approved", "This request has already been granted.") };
      }
      const { code } = await sendOtp(pool, consentOptions, view.requestRef);
      return {
        status: 200,
        body: consentPage(view, code, ctx.query.get("return") ?? undefined),
      };
    },
  },
  {
    method: "POST",
    path: "/consent/:ref/verify",
    handler: async (ctx) => {
      const { code } = form(ctx.rawBody);
      if (code === undefined || !/^[0-9]{6}$/.test(code)) {
        return { status: 400, body: resultPage("Check the code", "Six digits, please.") };
      }
      const outcome = await verifyAndGrant(pool, consentOptions, ctx.params.ref ?? "", code);
      switch (outcome.kind) {
        case "GRANTED":
          return {
            status: 200,
            body: resultPage(
              "Done",
              "The assistant can now shop for you, within the limits you set.",
              outcome.mandateId,
              ctx.query.get("return") ?? undefined,
            ),
          };
        case "WRONG_CODE":
          return { status: 400, body: resultPage("Wrong code", `${outcome.attemptsLeft} attempts left.`) };
        case "EXPIRED":
          return { status: 410, body: resultPage("Expired", "Start again from the assistant.") };
        default:
          return { status: 404, body: resultPage("Not found", "That link has expired or never existed.") };
      }
    },
  },
  {
    method: "POST",
    path: "/consent/:ref/reject",
    handler: () => ({ status: 200, body: resultPage("Nothing granted", "No permission was given.") }),
  },
  {
    method: "GET",
    path: "/agent/approve/:challenge",
    handler: async (ctx) => {
      // Rendered from server state only: the amount comes from the challenge row, which
      // came from the signed quote. Nothing the agent wrote appears on this screen.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await setMerchantContext(client, config.merchantId);
        const challenge = await findChallenge(client, ctx.params.challenge ?? "");
        await client.query("COMMIT");

        if (challenge === null || challenge.state !== "pending") {
          return { status: 404, body: resultPage("Not available", "This approval link has already been used or has expired.") };
        }
        return {
          status: 200,
          body: stepUpPage({
            challengeId: challenge.challengeId,
            merchantName: consentOptions.merchantName,
            amountPaise: challenge.amountPaise,
            expiresAt: challenge.expiresAt,
          }),
        };
      } finally {
        client.release();
      }
    },
  },
  {
    method: "POST",
    path: "/agent/approve/:challenge",
    handler: async (ctx) => {
      const decision = await approveStepUp(kernel, ctx.params.challenge ?? "", true);
      return decision.verdict === "ALLOW"
        ? { status: 200, body: resultPage("Approved", "Your order is on its way.", decision.intent_id) }
        : { status: 409, body: resultPage("Could not approve", `This is no longer valid (${decision.reason_code}).`) };
    },
  },
]);

/**
 * What the agent is told. The verifier's own reasoning is never included: it would be an
 * oracle for tuning attacks against it.
 */
function explain(reasonCode: string): Record<string, unknown> {
  if (reasonCode === "SEC-004") {
    return {
      explanation: "That didn't look like what you asked for, so I stopped.",
      recoverable: true,
      suggested_actions: ["restate_request", "confirm_manually"],
    };
  }
  return {};
}

/**
 * The consent and step-up pages are served by the kernel, not by `web`. What matters is
 * that they are rendered from server-held state by an operator the agent cannot influence
 * and the user can recognise.
 */
await listen(server, Number(process.env.PORT ?? 8080), "kernel");
