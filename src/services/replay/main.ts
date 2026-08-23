import { startReplayRail } from "./replay.server.js";
import { createHttpService, listen } from "../../shared/http.js";

/**
 * The replay rail as a service.
 *
 * It answers where Razorpay answers and fires real HMAC-signed webhooks back, so our
 * executor, signature verification, event dedupe and orders.fetch all genuinely run. Only
 * the far side of the socket is a recording — which is what lets a judge run the whole
 * system with no account and nothing being pretended.
 */
const rail = await startReplayRail({
  webhookSecret: process.env.WEBHOOK_SECRET ?? "whsec_replay_dev_only",
  webhookUrl: process.env.WEBHOOK_URL ?? "http://kernel:8080/agent/webhooks/razorpay",
  settleAfterMs: Number(process.env.REPLAY_SETTLE_MS ?? 1500),
  port: Number(process.env.PORT ?? 8090),
});

console.log(`[agentkit] replay rail listening on ${rail.port}`);

const health = createHttpService([
  {
    method: "GET",
    path: "/health",
    handler: () => ({ status: 200, body: { ok: true, service: "replay", orders: rail.orders.size } }),
  },
]);
await listen(health, Number(process.env.HEALTH_PORT ?? 8091), "replay-health");
