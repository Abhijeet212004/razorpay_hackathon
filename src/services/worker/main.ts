import { createExecutorHttpClient } from "../../modules/executor/executor.client.js";
import { compensateRevoked } from "../../modules/jobs/compensate-revoked.job.js";
import { expireChallenges, expireMandates } from "../../modules/jobs/expire.job.js";
import { reconcileAmbiguous } from "../../modules/jobs/reconcile-ambiguous.job.js";
import { releaseStaleReservations } from "../../modules/jobs/release-stale.job.js";
import { verifyAndAnchor } from "../../modules/jobs/verify-anchor.job.js";
import { refreshOperatorMetrics } from "../../modules/console/operator.js";
import { syncCatalog } from "../../modules/jobs/catalog-sync.job.js";
import { JOB_TIMINGS } from "../../modules/jobs/jobs.validation.js";
import { createExecutorReadRail } from "../../modules/rail/rail.proxy.js";
import { fulfil } from "../../modules/fulfilment/fulfilment.service.js";
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

// Reads provider truth through the executor. Razorpay has no read-only key, so holding
// one here to reconcile would mean holding one that can also charge.
const rail = createExecutorReadRail({
  mode: config.rail,
  baseUrl: config.executorUrl,
  token: config.executorToken,
  timeoutMs: 8000,
});

/**
 * The same hand-off the kernel makes when a webhook confirms a capture. Reconciling is
 * the other way an order reaches CAPTURED — usually because the webhook never arrived —
 * and it must reach the merchant by the same route, or the shopper has paid for an order
 * that exists nowhere they can see it.
 */
const fulfilUrl = process.env.MERCHANT_FULFIL_URL;

async function recordWithMerchant(intentId: string): Promise<void> {
  if (fulfilUrl === undefined) return;
  const result = await fulfil(
    kernelPool,
    {
      merchantId: config.merchantId,
      fulfilUrl,
      token: process.env.AGENTKIT_FULFIL_TOKEN ?? "",
      publicBaseUrl: config.publicBaseUrl,
      logger: consoleLogger,
    },
    intentId,
  );
  if (!result.ok) consoleLogger.warn(`order ${intentId} not recorded: ${result.detail}`);
}

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
  reconcileAmbiguous(kernelPool, rail, merchant, new Date(), recordWithMerchant),
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

// The merchant's own product endpoint, pulled into our priced catalog. This is also
// where injected product text is caught and quarantined.
const catalogUrl = process.env.CATALOG_URL;
if (catalogUrl !== undefined) {
  every(30_000, "catalog-sync", async () => {
    // As the worker: the kernel prices from this table and may not write it.
    const result = await syncCatalog(pool, {
      merchantId: merchant,
      catalogUrl,
      logger: consoleLogger,
    });
    if (result.quarantined.length > 0) {
      console.log(`[agentkit] quarantined ${result.quarantined.length} product(s)`);
    }
    return { changed: result.quarantined.length };
  });
}

// The operator console reads only what this writes: counts and sums, per merchant,
// each computed inside that merchant's own row level security context.
every(60_000, "operator-metrics", async () => {
  // As the worker: only it may write operator_metrics. The kernel serves public HTTP and
  // has no business producing the one table that is read across merchants.
  const written = await refreshOperatorMetrics(pool, [merchant]);
  return { changed: written };
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
