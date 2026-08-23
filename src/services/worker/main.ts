import { createExecutorHttpClient } from "../../modules/executor/executor.client.js";
import { compensateRevoked } from "../../modules/jobs/compensate-revoked.job.js";
import { expireChallenges, expireMandates } from "../../modules/jobs/expire.job.js";
import { reconcileAmbiguous } from "../../modules/jobs/reconcile-ambiguous.job.js";
import { releaseStaleReservations } from "../../modules/jobs/release-stale.job.js";
import { verifyAndAnchor } from "../../modules/jobs/verify-anchor.job.js";
import { JOB_TIMINGS } from "../../modules/jobs/jobs.validation.js";
import { createHttpRail } from "../../modules/rail/rail.http.js";
import { assertNoPaymentCredential } from "../../shared/credentials.js";
import { loadConfig, poolFor } from "../../shared/config.js";
import { ROLES } from "../../shared/db/roles.js";
import { createHttpService, listen } from "../../shared/http.js";
import { consoleLogger } from "../../shared/logger.js";

/**
 * The worker. Every non-terminal state has a job here that resolves it.
 *
 * It holds the anchor signing key and no payment credential: refunds go through the
 * executor service, which is the only process that can move money.
 */
assertNoPaymentCredential("worker");

const config = loadConfig();
const pool = poolFor(ROLES.worker);
const kernelPool = poolFor(ROLES.kernel);

const rail = createHttpRail({
  mode: config.rail,
  baseUrl: config.railBaseUrl,
  keyId: process.env.RZP_READ_KEY_ID ?? "rzp_test_replay",
  keySecret: process.env.RZP_READ_KEY_SECRET ?? "replay-has-no-real-secret",
  timeoutMs: 8000,
});

const executor = createExecutorHttpClient({
  baseUrl: config.executorUrl,
  token: config.executorToken,
});

let lastRun: Record<string, { at: string; changed: number }> = {};

async function run(name: string, job: () => Promise<{ changed: number }>): Promise<void> {
  try {
    const result = await job();
    lastRun[name] = { at: new Date().toISOString(), changed: result.changed };
    if (result.changed > 0) console.log(`[agentkit] ${name}: ${result.changed} changed`);
  } catch (error) {
    consoleLogger.error(`job ${name} failed`, error);
    consoleLogger.count(`worker.job.${name}.failed`);
  }
}

function every(ms: number, name: string, job: () => Promise<{ changed: number }>): void {
  const tick = () => void run(name, job);
  setTimeout(tick, 2_000);
  setInterval(tick, ms);
}

const merchant = config.merchantId;

// Without this one, a crashed executor consumes cap until the window rolls.
every(JOB_TIMINGS.reaperIntervalMs, "release-stale-reservations", () =>
  releaseStaleReservations(kernelPool, merchant),
);
every(30_000, "reconcile-ambiguous", () =>
  reconcileAmbiguous(kernelPool, rail, merchant, new Date(), executor),
);
every(60_000, "expire-mandates", () => expireMandates(kernelPool, merchant));
every(60_000, "expire-challenges", () => expireChallenges(kernelPool, merchant));
every(120_000, "compensate-revoked", () => compensateRevoked(kernelPool, executor, merchant));
every(JOB_TIMINGS.anchorIntervalMs, "verify-chain-anchor", async () => {
  const result = await verifyAndAnchor(pool, merchant);
  if (result.broken.length > 0) {
    // A broken chain halts that mandate rather than being repaired. Repairing tamper
    // evidence is indistinguishable from tampering.
    consoleLogger.error(`chain verification failed: ${result.broken.join(", ")}`);
    consoleLogger.count("worker.chain.broken");
  }
  return result;
});

const server = createHttpService([
  {
    method: "GET",
    path: "/health",
    handler: async () => {
      await pool.query("SELECT 1");
      return { status: 200, body: { ok: true, service: "worker", jobs: lastRun } };
    },
  },
]);

await listen(server, Number(process.env.PORT ?? 8082), "worker");
