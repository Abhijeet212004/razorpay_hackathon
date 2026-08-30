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
import { consentPage, instrumentPage, payPage, resultPage, stepUpPage } from "../../modules/consent/consent.pages.js";
import { bindConsentRefs } from "../../modules/consent/consent.service.js";
import { verifyAuthorizationToken } from "../../modules/consent/authorization-token.js";
import {
  refusal,
  resolveAgentTenant,
  resolveMerchantTenant,
} from "../../modules/merchant/merchant.tenant.js";
import { createInstrumentClient } from "../../modules/consent/instrument.client.js";
import {
  beginInstrumentSetup,
  completeInstrumentSetup,
  readMandateForInstrument,
  readPayableOrder,
  bankCeiling,
} from "../../modules/consent/instrument.service.js";
import { setMerchantContext } from "../../shared/db/merchant-context.js";
import * as console_ from "../../modules/console/console.repository.js";
import * as catalog from "../../modules/catalog/catalog.service.js";
import { CatalogSearchSchema } from "../../modules/catalog/catalog.validation.js";
import * as orders from "../../modules/orders/orders.service.js";
import { toolManifest } from "../../modules/agent/agent.tools.js";
import { handleMcp } from "../../modules/mcp/mcp.controller.js";
import { callerKey, consume } from "../../modules/ratelimit/ratelimit.service.js";
import { fulfil } from "../../modules/fulfilment/fulfilment.service.js";
import type { ToolClass } from "../../modules/agent/agent.tools.js";
import { ingestWebhook } from "../../modules/reconciler/reconciler.service.js";
import { createExecutorReadRail } from "../../modules/rail/rail.proxy.js";
import { scriptedVerifier } from "../../modules/verifier/verifier.service.js";
import { assertNoPaymentCredential } from "../../shared/credentials.js";
import { loadConfig, poolFor } from "../../shared/config.js";
import { ROLES } from "../../shared/db/roles.js";
import {
  createHttpService,
  listen,
  type Handler,
  type HandlerResult,
  type RequestContext,
} from "../../shared/http.js";
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

// Reads provider truth through the executor. Razorpay has no read-only key, so holding
// one here to reconcile would mean holding one that can also charge.
const rail = createExecutorReadRail({
  mode: config.rail,
  baseUrl: config.executorUrl,
  token: config.executorToken,
  timeoutMs: 8000,
});

const instruments = createInstrumentClient({
  baseUrl: config.executorUrl,
  token: config.executorToken,
});

/**
 * Everything a request needs is built from the merchant it resolved to, not from a global.
 *
 * These were module-level singletons baked with one merchant id, which is why the kernel
 * could only ever serve one tenant however well row level security scoped the tables.
 * Making them functions is the enforcement: a handler cannot construct its dependencies
 * without having first resolved a merchant, so forgetting to is a compile error rather
 * than a silent read of somebody else's data.
 */
const verifier = scriptedVerifier();

const instrumentDepsFor = (merchantId: string) => ({
  pool,
  merchantId,
  client: instruments,
});

const kernelFor = (merchantId: string) => ({
  pool,
  verifier,
  clock: systemClock,
  logger: consoleLogger,
  executor,
  config: { ...DEFAULT_KERNEL_CONFIG, merchantId },
});

const HTML = { "Content-Type": "text/html; charset=utf-8" };

/**
 * A deployment serving one merchant names it here and needs no keys; that is the
 * self-hosted and demo case. A hosted deployment leaves it unset, and then a request
 * without a recognised credential resolves to nobody rather than to somebody.
 */
const tenantOptions = {
  pool,
  defaultMerchantId: process.env.MERCHANT_ID?.trim() || null,
};

type TenantHandler = (
  ctx: RequestContext,
  merchantId: string,
) => Promise<HandlerResult> | HandlerResult;

/** Agent-facing: the API key decides whose limits bind this request. */
function agentRoute(handler: TenantHandler): Handler {
  return async (ctx) => {
    const outcome = await resolveAgentTenant(tenantOptions, ctx);
    if (outcome.kind !== "TENANT") return refusal(outcome);
    return handler(ctx, outcome.merchantId);
  };
}

/** The merchant's own backend, which presents a different secret on a different header. */
function merchantRoute(handler: TenantHandler): Handler {
  return async (ctx) => {
    const outcome = await resolveMerchantTenant(tenantOptions, ctx);
    if (outcome.kind !== "TENANT") return refusal(outcome);
    return handler(ctx, outcome.merchantId);
  };
}

const consentOptionsFor = (merchantId: string) => ({
  merchantId,
  merchantName: process.env.MERCHANT_NAME ?? "Sharma Kirana",
  otpTtlMs: 5 * 60_000,
  demoMode: process.env.CONSENT_DEMO_MODE !== "false",
});

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

const mcpFor = (merchantId: string) => ({
  pool,
  kernel: kernelFor(merchantId),
  options: {
    merchantId,
    publicBaseUrl: config.publicBaseUrl,
    merchantAuthorizeUrl: config.merchantAuthorizeUrl,
    exposed: exposedClasses,
    consent: consentOptionsFor(merchantId),
    logger: consoleLogger,
  },
});

/**
 * Where an agent's purchase becomes a real order in the merchant's own system. Optional:
 * a merchant with no order API simply does not set it, and the ledger is still complete.
 */
const fulfilUrl = process.env.MERCHANT_FULFIL_URL;

/** The shared secret the merchant's own backend uses to reach the kernel. */
const merchantToken = process.env.AGENTKIT_FULFIL_TOKEN ?? "";

function consentUrlFor(requestRef: string): string {
  return config.merchantAuthorizeUrl === null
    ? `${config.publicBaseUrl}/consent/${requestRef}`
    : `${config.merchantAuthorizeUrl}?ref=${encodeURIComponent(requestRef)}`;
}

async function recordWithMerchant(merchantId: string, intentId: string): Promise<void> {
  if (fulfilUrl === undefined) return;
  const result = await fulfil(
    pool,
    {
      merchantId,
      fulfilUrl,
      token: process.env.AGENTKIT_FULFIL_TOKEN ?? "",
      publicBaseUrl: config.publicBaseUrl,
      logger: consoleLogger,
    },
    intentId,
  );
  if (!result.ok) consoleLogger.warn(`order ${intentId} not recorded: ${result.detail}`);
}

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
    // Public: an agent has no credential yet, which is what this endpoint is for. It
    // describes the deployment's merchant, or refuses to guess when hosted.
    handler: agentRoute((_ctx, merchantId) => ({
      status: 200,
      body: {
        merchant_id: merchantId,
        transports: ["mcp", "acp", "http"],
        mcp: `${config.publicBaseUrl}/agent/mcp`,
        // One hop from discovery to the full tool surface.
        tools: `${config.publicBaseUrl}/agent/tools`,
        register_url: `${config.publicBaseUrl}/agent/register`,
        grant_url: `${config.publicBaseUrl}/consent/request`,
        mandate: { shape: "policy-mandate/v1", currency: "INR" },
      },
    })),
  },
  {
    method: "POST",
    path: "/agent/register",
    handler: agentRoute(async (ctx, merchantId) => {
      const body = JSON.parse(ctx.rawBody) as { name: string; public_key: string };
      const result = await registerAgent(pool, body);
      // Identity, not authority. Every money call still denies until a mandate exists.
      return { status: 201, body: { agent_id: result.agentId, attestation: result.attestation } };
    }),
  },
  {
    // MCP over Streamable HTTP. A second door onto the same tools, and the same gate.
    method: "POST",
    path: "/agent/mcp",
    handler: agentRoute((ctx, merchantId) =>
      handleMcp({ ...mcpFor(merchantId), trustProxy: process.env.TRUST_PROXY === "true" }, ctx),
    ),
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
    handler: agentRoute(async (ctx, merchantId) => {
      const raw = JSON.parse(ctx.rawBody) as { mandate_id?: string };
      const parsed = CatalogSearchSchema.safeParse(raw);
      if (!parsed.success) return { status: 400, body: { error: "invalid_request" } };

      const result = await catalog.search(
        pool,
        { merchantId: merchantId },
        parsed.data,
        raw.mandate_id,
      );
      return { status: 200, body: result };
    }),
  },
  {
    method: "GET",
    path: "/agent/catalog/:sku",
    handler: agentRoute(async (ctx, merchantId) => {
      const item = await catalog.getItem(
        pool,
        { merchantId: merchantId },
        ctx.params.sku ?? "",
        ctx.query.get("mandate_id") ?? undefined,
      );
      return item === null
        ? { status: 404, body: { error: "unknown_sku", recoverable: true } }
        : { status: 200, body: item };
    }),
  },
  {
    method: "GET",
    path: "/agent/mandate/:mandate_id",
    handler: agentRoute(async (ctx, merchantId) => {
      const view = await orders.spendRemaining(
        pool,
        { merchantId: merchantId },
        ctx.params.mandate_id ?? "",
      );
      // An unknown mandate and a mandate belonging to another merchant are the same
      // answer on purpose: row level security makes them indistinguishable here.
      return view === null
        ? { status: 404, body: { error: "unknown_mandate", reason_code: "MND-001" } }
        : { status: 200, body: view };
    }),
  },
  {
    method: "POST",
    path: "/agent/orders/history",
    handler: agentRoute(async (ctx, merchantId) => {
      const body = JSON.parse(ctx.rawBody) as { mandate_id?: string; limit?: number };
      if (body.mandate_id === undefined) {
        return { status: 400, body: { error: "mandate_id is required" } };
      }
      const list = await orders.history(
        pool,
        { merchantId: merchantId },
        body.mandate_id,
        body.limit ?? 20,
      );
      return { status: 200, body: { orders: list } };
    }),
  },
  {
    method: "POST",
    path: "/agent/orders/status",
    handler: agentRoute(async (ctx, merchantId) => {
      const body = JSON.parse(ctx.rawBody) as { mandate_id?: string; intent_id?: string };
      if (body.mandate_id === undefined || body.intent_id === undefined) {
        return { status: 400, body: { error: "mandate_id and intent_id are required" } };
      }
      const view = await orders.status(
        pool,
        { merchantId: merchantId },
        body.mandate_id,
        body.intent_id,
      );
      return view === null
        ? { status: 404, body: { error: "unknown_order" } }
        : { status: 200, body: view };
    }),
  },
  {
    method: "POST",
    path: "/agent/orders/reorder",
    handler: agentRoute(async (ctx, merchantId) => {
      const body = JSON.parse(ctx.rawBody) as { mandate_id?: string; intent_id?: string };
      if (body.intent_id === undefined) {
        return { status: 400, body: { error: "intent_id is required" } };
      }
      const items = await orders.reorderBasket(
        pool,
        { merchantId: merchantId },
        body.intent_id,
      );
      // Line items only. Quoting them again is a separate call, and it faces every
      // check from scratch — yesterday's approval buys nothing today.
      return {
        status: 200,
        body: { items, note: "quote these again; the price and your limits are checked afresh" },
      };
    }),
  },
  {
    method: "POST",
    path: "/agent/orders/cancel",
    handler: agentRoute(async (ctx, merchantId) => {
      const body = JSON.parse(ctx.rawBody) as { mandate_id?: string; intent_id?: string };
      if (body.mandate_id === undefined || body.intent_id === undefined) {
        return { status: 400, body: { error: "mandate_id and intent_id are required" } };
      }
      const outcome = await orders.cancel(
        pool,
        { merchantId: merchantId },
        body.mandate_id,
        body.intent_id,
      );
      const status =
        outcome.kind === "CANCELLED" ? 200 : outcome.kind === "NOT_FOUND" ? 404 : 409;
      return { status, body: outcome };
    }),
  },
  {
    method: "POST",
    path: "/agent/quote",
    handler: agentRoute(async (ctx, merchantId) => {
      const body = JSON.parse(ctx.rawBody) as {
        mandate_id: string;
        items: Array<{ sku: string; quantity: number }>;
      };
      try {
        const quote = await priceBasket(
          pool,
          { merchantId: merchantId, quoteTtlMs: DEFAULT_KERNEL_CONFIG.quoteTtlMs },
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
    }),
  },
  {
    method: "POST",
    path: "/agent/acp/checkout",
    handler: agentRoute(async (ctx, merchantId) => {
      const parsed = AuthorizationRequestSchema.safeParse(JSON.parse(ctx.rawBody));
      if (!parsed.success) return { status: 400, body: { error: "invalid_request" } };

      const decision = await authorize(kernelFor(merchantId), parsed.data);

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
          // Present once an intent is authorised: where a person supplies the money for
          // the order the executor made. An agent can hand this to its user; it cannot
          // pay it, and nothing on that page comes from the agent.
          pay_url:
            decision.verdict === "ALLOW"
              ? `${config.publicBaseUrl}/pay/${decision.intent_id}`
              : null,
          ...explain(decision.reason_code),
        },
      };
    }),
  },
  {
    method: "POST",
    path: "/agent/webhooks/razorpay",
    handler: agentRoute(async (ctx, merchantId) => {
      const signature = ctx.headers["x-razorpay-signature"];
      const outcome = await ingestWebhook(
        {
          pool,
          rail,
          webhookSecret: config.webhookSecret,
          merchantId: merchantId,
          logger: consoleLogger,
          onCaptured: (intentId: string) => recordWithMerchant(merchantId, intentId),
        },
        ctx.rawBody,
        typeof signature === "string" ? signature : undefined,
      );
      // An unverified event gets a 401; a duplicate gets a 200, because the sender did
      // nothing wrong and retrying would not help.
      return outcome.kind === "UNVERIFIED"
        ? { status: 401, body: { error: "signature_invalid" } }
        : { status: 200, body: outcome };
    }),
  },
  {
    // Read-only agent activity, for the merchant's own admin. The console role is
    // SELECT-only and row level security scoped, so this cannot write history or read
    // another merchant's.
    method: "GET",
    path: "/console/:view",
    handler: agentRoute(async (ctx, merchantId) => {
      const merchant = merchantId;
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
    }),
  },
  {
    method: "POST",
    path: "/consent/request",
    handler: agentRoute(async (ctx, merchantId) => {
      // LMT-005. This endpoint sends a one-time code to a number the caller supplies,
      // so on a public deployment it is an SMS-bombing primitive if left open.
      const limit = await consume(
        pool,
        merchantId,
        "consent",
        callerKey(ctx.headers, process.env.TRUST_PROXY === "true"),
      );
      if (!limit.allowed) {
        return {
          status: 429,
          headers: { "Retry-After": String(limit.retryAfter) },
          body: { error: "rate_limited", reason_code: "LMT-005", retry_after_seconds: limit.retryAfter },
        };
      }

      const parsed = RequestConsentSchema.safeParse(JSON.parse(ctx.rawBody));
      if (!parsed.success) return { status: 400, body: { error: "invalid_request" } };
      const { requestRef } = await requestConsent(pool, consentOptionsFor(merchantId), parsed.data);
      // A reference, never a grant.
      return {
        status: 202,
        body: {
          request_ref: requestRef,
          // Via the merchant when it has a surface that knows the shopper, so the
          // grant can be bound to them. Straight to the consent screen otherwise.
          consent_url: consentUrlFor(requestRef),
        },
      };
    }),
  },
  {
    // How an agent learns whether it was permitted, without reading the human's screen.
    method: "GET",
    path: "/consent/:ref/status",
    handler: agentRoute(async (ctx, merchantId) => {
      const status = await consentStatus(pool, consentOptionsFor(merchantId), ctx.params.ref ?? "");
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
    }),
  },
  {
    // The merchant naming who is approving, and where their order goes.
    //
    // Called server-to-server from the merchant's own backend, which knows the logged-in
    // shopper — something the kernel cannot know, because it serves this screen from a
    // different origin than the one holding the shopper's session.
    //
    // Only accepted before the grant exists. Afterwards the delivery target is fixed:
    // an agent cannot name an address, so a compromised merchant must not be able to
    // change one on the agent's behalf either.
    method: "POST",
    path: "/consent/:ref/bind",
    handler: agentRoute(async (ctx, merchantId) => {
      if (ctx.headers["x-agentkit-token"] !== merchantToken) {
        return { status: 401, body: { error: "unauthorised" } };
      }
      const body = JSON.parse(ctx.rawBody) as {
        customer_ref?: string;
        fulfilment_ref?: string;
      };
      if (
        body.customer_ref === undefined ||
        body.fulfilment_ref === undefined ||
        body.customer_ref.length === 0 ||
        body.fulfilment_ref.length === 0
      ) {
        return { status: 400, body: { error: "customer_ref and fulfilment_ref are required" } };
      }

      const outcome = await bindConsentRefs(pool, consentOptionsFor(merchantId), ctx.params.ref ?? "", {
        customerRef: body.customer_ref,
        fulfilmentRef: body.fulfilment_ref,
      });

      switch (outcome.kind) {
        case "BOUND":
          return { status: 200, body: { bound: true } };
        case "ALREADY_BOUND":
          return { status: 409, body: { error: "already_bound", reason_code: "CNS-002" } };
        case "NOT_PENDING":
          return { status: 409, body: { error: "not_pending", reason_code: "CNS-002" } };
        default:
          return { status: 404, body: { error: "unknown_request" } };
      }
    }),
  },
  {
    method: "GET",
    path: "/consent/:ref",
    handler: agentRoute(async (ctx, merchantId) => {
      const view = await readConsentRequest(pool, consentOptionsFor(merchantId), ctx.params.ref ?? "");
      if (view === null) {
        return { status: 404, body: resultPage("Not found", "That link has expired or never existed.") };
      }
      if (view.state === "granted") {
        return { status: 200, body: resultPage("Already approved", "This request has already been granted.") };
      }
      // The merchant's claim about who is approving, carried here by the shopper's own
      // browser rather than asserted out of band. Binding happens on this request only,
      // is refused once the grant exists, and is shown to the shopper below so a wrong
      // one can be caught by the only party able to recognise it.
      let approving: { name: string; address: string } | undefined;
      const auth = ctx.query.get("auth");
      if (auth !== null) {
        const outcome = verifyAuthorizationToken(merchantToken, auth, view.requestRef);
        if (outcome.kind !== "VALID") {
          return {
            status: 400,
            body: resultPage(
              "That link is not valid",
              "Start again from your account page at the merchant.",
              outcome.kind.toLowerCase(),
            ),
          };
        }
        const bound = await bindConsentRefs(pool, consentOptionsFor(merchantId), view.requestRef, {
          customerRef: outcome.claims.customerRef,
          fulfilmentRef: outcome.claims.fulfilmentRef,
        });
        // ALREADY_BOUND is not an error here: a shopper refreshing this page must not be
        // told something went wrong. It is only an error when the claim disagrees, and
        // the claim cannot change what is already bound.
        if (bound.kind !== "BOUND" && bound.kind !== "ALREADY_BOUND") {
          return {
            status: 409,
            body: resultPage("Too late", "That request has already been decided."),
          };
        }
        approving = {
          name: outcome.claims.displayName,
          address: outcome.claims.displayAddress,
        };
      }

      const { code } = await sendOtp(pool, consentOptionsFor(merchantId), view.requestRef);
      return {
        status: 200,
        body: consentPage(view, code, ctx.query.get("return") ?? undefined, approving),
      };
    }),
  },
  {
    method: "POST",
    path: "/consent/:ref/verify",
    handler: agentRoute(async (ctx, merchantId) => {
      const { code } = form(ctx.rawBody);
      if (code === undefined || !/^[0-9]{6}$/.test(code)) {
        return { status: 400, body: resultPage("Check the code", "Six digits, please.") };
      }
      const outcome = await verifyAndGrant(pool, consentOptionsFor(merchantId), ctx.params.ref ?? "", code);
      switch (outcome.kind) {
        case "GRANTED": {
          // The grant is real from here. What follows is how it gets paid for, and it is
          // deliberately a separate decision the shopper can decline.
          const back = ctx.query.get("return");
          return {
            status: 303,
            headers: {
              Location: `/mandate/${outcome.mandateId}/instrument${
                back === null ? "" : `?return=${encodeURIComponent(back)}`
              }`,
            },
            body: "",
          };
        }
        case "WRONG_CODE":
          return { status: 400, body: resultPage("Wrong code", `${outcome.attemptsLeft} attempts left.`) };
        case "EXPIRED":
          return { status: 410, body: resultPage("Expired", "Start again from the assistant.") };
        default:
          return { status: 404, body: resultPage("Not found", "That link has expired or never existed.") };
      }
    }),
  },
  {
    method: "POST",
    path: "/consent/:ref/reject",
    handler: () => ({ status: 200, body: resultPage("Nothing granted", "No permission was given.") }),
  },
  {
    // Where a person pays for an order their assistant asked for. The rail order already
    // exists; this only supplies the money, and the webhook is what makes it true.
    method: "GET",
    path: "/pay/:intentId",
    handler: agentRoute(async (ctx, merchantId) => {
      const view = await readPayableOrder(pool, merchantId, ctx.params.intentId ?? "");
      if (view === null) {
        return { status: 404, body: resultPage("Not found", "No order is waiting on payment.") };
      }
      if (view.state === "CAPTURED") {
        return { status: 200, body: resultPage("Already paid", "This order is settled.", view.intentId) };
      }
      if (view.railOrderId === null) {
        return {
          status: 409,
          body: resultPage("Not ready", "The order never reached the rail, so there is nothing to pay."),
        };
      }
      return {
        status: 200,
        body: payPage(
          {
            intentId: view.intentId,
            merchantName: consentOptionsFor(merchantId).merchantName,
            amountPaise: view.amountPaise,
            railOrderId: view.railOrderId,
          },
          await instruments.publishableKey(),
        ),
      };
    }),
  },
  {
    method: "GET",
    path: "/mandate/:id/instrument",
    handler: agentRoute(async (ctx, merchantId) => {
      const mandate = await readMandateForInstrument(instrumentDepsFor(merchantId), ctx.params.id ?? "");
      if (mandate === null) {
        return { status: 404, body: resultPage("Not found", "That mandate does not exist.") };
      }
      if (mandate.tokenId !== null) {
        return {
          status: 200,
          body: resultPage("Already set up", "A way to pay is already attached.", mandate.mandateId),
        };
      }
      const keyId = await instruments.publishableKey();
      return {
        status: 200,
        body: instrumentPage(
          {
            mandateId: mandate.mandateId,
            merchantName: consentOptionsFor(merchantId).merchantName,
            agentName: mandate.agentName,
            maxAmountPaise: bankCeiling(mandate),
            perTransactionPaise: mandate.perTransactionPaise,
            ...(ctx.query.get("return") === null
              ? {}
              : { returnTo: ctx.query.get("return")! }),
          },
          keyId,
        ),
      };
    }),
  },
  {
    method: "POST",
    path: "/mandate/:id/instrument/start",
    handler: agentRoute(async (ctx, merchantId) => {
      const method = ctx.query.get("method") === "card" ? "card" : "upi";
      const started = await beginInstrumentSetup(instrumentDepsFor(merchantId), ctx.params.id ?? "", method);
      return started === null
        ? { status: 404, body: { error: "unknown mandate" } }
        : {
            status: 200,
            body: {
              customer_id: started.customerId,
              rail_order_id: started.railOrderId,
              amount_paise: started.amountPaise,
            },
          };
    }),
  },
  {
    method: "POST",
    path: "/mandate/:id/instrument/complete",
    handler: agentRoute(async (ctx, merchantId) => {
      const outcome = await completeInstrumentSetup(instrumentDepsFor(merchantId), ctx.params.id ?? "");
      switch (outcome.kind) {
        case "ATTACHED":
          return { status: 200, body: { attached: true, method: outcome.method } };
        case "NOT_YET":
          return {
            status: 200,
            body: { attached: false, error: "Your bank has not confirmed the mandate yet." },
          };
        default:
          return { status: 404, body: { attached: false, error: "unknown mandate" } };
      }
    }),
  },
  {
    method: "POST",
    path: "/mandate/:id/instrument/skip",
    handler: agentRoute((ctx, merchantId) => ({
      status: 200,
      body: resultPage(
        "Done",
        "The assistant can shop for you, within the limits you set. It has no way to pay " +
          "yet, so it will ask you to add one when it needs to.",
        ctx.params.id,
        ctx.query.get("return") ?? undefined,
      ),
    })),
  },
  {
    method: "GET",
    path: "/mandate/:id/instrument/done",
    handler: agentRoute((ctx, merchantId) => ({
      status: 200,
      body: resultPage(
        "All set",
        "Your bank has authorised the mandate. The assistant can now buy within your " +
          "limits, and you can revoke this at any time.",
        ctx.params.id,
      ),
    })),
  },
  {
    method: "GET",
    path: "/agent/approve/:challenge",
    handler: agentRoute(async (ctx, merchantId) => {
      // Rendered from server state only: the amount comes from the challenge row, which
      // came from the signed quote. Nothing the agent wrote appears on this screen.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await setMerchantContext(client, merchantId);
        const challenge = await findChallenge(client, ctx.params.challenge ?? "");
        await client.query("COMMIT");

        if (challenge === null || challenge.state !== "pending") {
          return { status: 404, body: resultPage("Not available", "This approval link has already been used or has expired.") };
        }
        return {
          status: 200,
          body: stepUpPage({
            challengeId: challenge.challengeId,
            merchantName: consentOptionsFor(merchantId).merchantName,
            amountPaise: challenge.amountPaise,
            expiresAt: challenge.expiresAt,
          }),
        };
      } finally {
        client.release();
      }
    }),
  },
  {
    method: "POST",
    path: "/agent/approve/:challenge",
    handler: agentRoute(async (ctx, merchantId) => {
      const decision = await approveStepUp(kernelFor(merchantId), ctx.params.challenge ?? "", true);
      if (decision.verdict !== "ALLOW") {
        return {
          status: 409,
          body: resultPage("Could not approve", `This is no longer valid (${decision.reason_code}).`),
        };
      }
      // Approving says the purchase may happen. Paying is a separate act, on a page whose
      // every figure comes from the order rather than from the agent.
      return {
        status: 303,
        headers: { Location: `/pay/${decision.intent_id}` },
        body: "",
      };
    }),
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
