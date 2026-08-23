import { createExecutor } from "../../modules/executor/executor.service.js";
import { createHttpRail } from "../../modules/rail/rail.http.js";
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
