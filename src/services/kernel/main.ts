import { authorize, DEFAULT_KERNEL_CONFIG } from "../../modules/authorization/authorization.service.js";
import { AuthorizationRequestSchema } from "../../modules/authorization/authorization.validation.js";
import { createExecutorHttpClient } from "../../modules/executor/executor.client.js";
import { priceBasket } from "../../modules/quote/quote.service.js";
import { registerAgent } from "../../modules/identity/identity.service.js";
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
        transports: ["acp"],
        catalog: `${config.publicBaseUrl}/agent/catalog.json`,
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
    method: "POST",
    path: "/agent/quote",
    handler: async (ctx) => {
      const body = JSON.parse(ctx.rawBody) as {
        mandate_id: string;
        items: Array<{ sku: string; quantity: number }>;
      };
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

await listen(server, Number(process.env.PORT ?? 8080), "kernel");
