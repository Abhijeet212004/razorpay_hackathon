import { createExecutor } from "../../modules/executor/executor.service.js";
import { createHttpRail } from "../../modules/rail/rail.http.js";
import type { RailOrder } from "../../modules/rail/rail.validation.js";
import { loadConfig, poolFor } from "../../shared/config.js";
import { ROLES } from "../../shared/db/roles.js";
import { createHttpService, listen, type RequestContext } from "../../shared/http.js";
import { consoleLogger } from "../../shared/logger.js";

/**
 * The executor service. It holds the only payment credential in the system and has no
 * public ingress: compose does not publish a port for it, and both callers reach it over
 * the internal network with a shared token.
 *
 * Note what is deliberately absent — this process never authorises anything. It is told
 * what to do by a kernel that cannot do it.
 */

const config = loadConfig();
const pool = poolFor(ROLES.kernel);

const rail = createHttpRail({
  mode: config.rail,
  baseUrl: config.railBaseUrl,
  keyId: process.env.RZP_KEY_ID ?? "rzp_test_replay",
  keySecret: process.env.RZP_KEY_SECRET ?? "replay-has-no-real-secret",
  timeoutMs: Number(process.env.RAIL_TIMEOUT_MS ?? 8000),
});

const executor = createExecutor({ pool, rail, logger: consoleLogger });

/** Paise stay decimal strings across the wire: a JSON number would lose them. */
function toWire(order: RailOrder): Record<string, unknown> {
  return {
    railOrderId: order.railOrderId,
    status: order.status,
    amountPaise: order.amountPaise.toString(),
    amountPaidPaise: order.amountPaidPaise.toString(),
    railPaymentId: order.railPaymentId,
    notes: order.notes,
  };
}

function authorised(ctx: RequestContext): boolean {
  return ctx.headers["x-executor-token"] === config.executorToken;
}

const server = createHttpService([
  {
    method: "GET",
    path: "/health",
    handler: () => ({ status: 200, body: { ok: true, service: "executor", rail: config.rail } }),
  },
  {
    method: "POST",
    path: "/execute",
    handler: async (ctx) => {
      if (!authorised(ctx)) return { status: 401, body: { error: "unauthorised" } };
      const body = JSON.parse(ctx.rawBody) as {
        intentId: string;
        mandateId: string;
        merchantId: string;
        amountPaise: string;
        decisionId: string;
      };
      const result = await executor.execute({
        intentId: body.intentId,
        mandateId: body.mandateId,
        merchantId: body.merchantId,
        amountPaise: BigInt(body.amountPaise),
        decisionId: body.decisionId,
      });
      return { status: 200, body: result };
    },
  },
  {
    // Provider truth, read on behalf of a process that must not hold a credential to get
    // it. Read-only: nothing on these two paths can move money.
    method: "GET",
    path: "/orders/by-intent/:intentId",
    handler: async (ctx) => {
      if (!authorised(ctx)) return { status: 401, body: { error: "unauthorised" } };
      const order = await rail.findOrderByIntent(ctx.params.intentId!);
      return order === null
        ? { status: 404, body: { error: "no_such_order" } }
        : { status: 200, body: toWire(order) };
    },
  },
  {
    method: "GET",
    path: "/orders/:railOrderId",
    handler: async (ctx) => {
      if (!authorised(ctx)) return { status: 401, body: { error: "unauthorised" } };
      try {
        return { status: 200, body: toWire(await rail.fetchOrder(ctx.params.railOrderId!)) };
      } catch {
        return { status: 404, body: { error: "no_such_order" } };
      }
    },
  },
  {
    // The publishable key. It goes in a browser by design and cannot move money alone,
    // but it still leaves this process only over an authenticated call, so no other
    // service has to carry any part of a Razorpay credential in its environment.
    method: "GET",
    path: "/publishable-key",
    handler: (ctx) =>
      authorised(ctx)
        ? { status: 200, body: { keyId: process.env.RZP_KEY_ID ?? "rzp_test_replay" } }
        : { status: 401, body: { error: "unauthorised" } },
  },
  {
    method: "GET",
    path: "/tokens/:customerId",
    handler: async (ctx) => {
      if (!authorised(ctx)) return { status: 401, body: { error: "unauthorised" } };
      const token = await rail.findToken(ctx.params.customerId!);
      return token === null
        ? { status: 404, body: { error: "no_token" } }
        : {
            status: 200,
            body: {
              tokenId: token.tokenId,
              method: token.method,
              maxAmountPaise: token.maxAmountPaise === null ? null : token.maxAmountPaise.toString(),
            },
          };
    },
  },
  {
    // Setting up an instrument. Only ever reached with the shopper present and approving.
    method: "POST",
    path: "/mandate/setup",
    handler: async (ctx) => {
      if (!authorised(ctx)) return { status: 401, body: { error: "unauthorised" } };
      const body = JSON.parse(ctx.rawBody) as {
        name: string;
        email: string;
        contact: string;
        maxAmountPaise: string;
        amountPaise: string;
        expiresAt: string;
        method: "upi" | "card" | "emandate";
        notes?: Record<string, string>;
      };

      const customer = await rail.createCustomer({
        name: body.name,
        email: body.email,
        contact: body.contact,
      });
      const order = await rail.createMandateOrder({
        customerId: customer.customerId,
        maxAmountPaise: BigInt(body.maxAmountPaise),
        amountPaise: BigInt(body.amountPaise),
        expiresAt: new Date(body.expiresAt),
        method: body.method,
        notes: body.notes ?? {},
      });

      return {
        status: 200,
        body: {
          customerId: customer.customerId,
          railOrderId: order.railOrderId,
          amountPaise: order.amountPaise.toString(),
          keyId: process.env.RZP_KEY_ID ?? "rzp_test_replay",
        },
      };
    },
  },
  {
    method: "POST",
    path: "/refund",
    handler: async (ctx) => {
      if (!authorised(ctx)) return { status: 401, body: { error: "unauthorised" } };
      const body = JSON.parse(ctx.rawBody) as {
        orderId: string;
        merchantId: string;
        amountPaise: string;
        reason: string;
      };
      const result = await executor.refund({
        orderId: body.orderId,
        merchantId: body.merchantId,
        amountPaise: BigInt(body.amountPaise),
        reason: body.reason,
      });
      return { status: 200, body: result };
    },
  },
]);

await listen(server, Number(process.env.PORT ?? 8081), "executor");
