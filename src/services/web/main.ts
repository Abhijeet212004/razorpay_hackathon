import { appendOperationsEvent } from "../../modules/ledger/ledger.operations.js";
import { auditPage, consolePage } from "../../modules/console/console.pages.js";
import * as repo from "../../modules/console/console.repository.js";
import { readOperatorMetrics } from "../../modules/console/operator.js";
import { operatorPage } from "../../modules/console/operator.pages.js";
import { assertNoPaymentCredential } from "../../shared/credentials.js";
import { loadConfig, poolFor } from "../../shared/config.js";
import { ROLES } from "../../shared/db/roles.js";
import { createHttpService, listen } from "../../shared/http.js";

/**
 * Storefront and consoles. Reads Postgres directly as agentkit_console, which is
 * SELECT-only and row level security scoped, so a bug here cannot write history or read
 * another merchant's.
 */
assertNoPaymentCredential("web");

const config = loadConfig();
const pool = poolFor(ROLES.console);
// Impersonation writes to the merchant's operations chain, which the console role cannot
// do. That is deliberate: an audited action needs a principal that can be audited.
const kernelPool = poolFor(ROLES.kernel);

const HTML = { "Content-Type": "text/html; charset=utf-8" };
// INV-23: the active mode is on every page and in the API. Never let a viewer mistake
// replay for live.
const mode = { rail: config.rail, live: config.rail === "razorpay" };

function form(raw: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(raw).entries());
}

const server = createHttpService([
  {
    method: "GET",
    path: "/health",
    handler: async () => {
      await pool.query("SELECT 1");
      return { status: 200, body: { ok: true, service: "web" } };
    },
  },
  {
    method: "GET",
    path: "/api/mode",
    handler: () => ({
      status: 200,
      body: {
        rail: config.rail,
        brain: config.brain,
        verifier: config.verifier,
        live: mode.live,
        label: mode.live ? "LIVE — Razorpay Test Mode" : "REPLAY — recorded rail",
      },
    }),
  },
  {
    method: "GET",
    path: "/",
    handler: async () => {
      const [decisions, mandates, denials, quarantined] = await Promise.all([
        repo.recentDecisions(pool, config.merchantId),
        repo.mandates(pool, config.merchantId),
        repo.denialCounts(pool, config.merchantId),
        repo.quarantined(pool, config.merchantId),
      ]);
      return {
        status: 200,
        headers: HTML,
        body: consolePage({ mode, decisions, mandates, denials, quarantined }),
      };
    },
  },
  {
    method: "GET",
    path: "/audit",
    handler: async (ctx) => {
      // The round trip: an intent id read off a Razorpay order's notes field lands here.
      const intentId = ctx.query.get("intent_id") ?? "";
      const entries = await repo.trace(pool, config.merchantId, intentId);
      return { status: 200, headers: HTML, body: auditPage(mode, intentId, entries) };
    },
  },
  {
    method: "GET",
    path: "/operator",
    handler: async () => {
      const rows = await readOperatorMetrics(pool);
      return { status: 200, headers: HTML, body: operatorPage(rows) };
    },
  },
  {
    method: "POST",
    path: "/operator/impersonate",
    handler: async (ctx) => {
      const merchantId = form(ctx.rawBody).merchant_id ?? "";
      const entry = await appendOperationsEvent(
        kernelPool,
        {
          merchantId,
          lockTimeoutMs: 3_000,
          statementTimeoutMs: 5_000,
          retryAttempts: 3,
          retryBackoffMs: [10, 40, 160],
        },
        {
          kind: "IMPERSONATION",
          operator: process.env.OPERATOR_ID ?? "operator",
          reason: "console drill-down",
        },
      );
      // The audit entry is written before the data is shown, not after. A read that
      // failed to record itself does not happen.
      return entry === null
        ? { status: 404, body: { error: "unknown_merchant" } }
        : {
            status: 303,
            headers: { Location: "/", ...HTML },
            body: `<!doctype html><p>Recorded on ${merchantId}'s chain at seq ${entry.seq}. <a href="/">Continue</a></p>`,
          };
    },
  },
]);

await listen(server, Number(process.env.PORT ?? 8083), "web");
