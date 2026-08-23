import { assertNoPaymentCredential } from "../../shared/credentials.js";
import { loadConfig, poolFor } from "../../shared/config.js";
import { ROLES } from "../../shared/db/roles.js";
import { createHttpService, listen } from "../../shared/http.js";
import { setMerchantContext } from "../../shared/db/merchant-context.js";

/**
 * Storefront and audit console. Reads Postgres directly as agentkit_console, which is
 * SELECT-only and scoped by row level security, so a bug here cannot write history or
 * read another merchant's.
 *
 * The console itself arrives in Phase 6. What exists now is the health endpoint and the
 * mode badge, because a viewer must never mistake replay for live.
 */
assertNoPaymentCredential("web");

const config = loadConfig();
const pool = poolFor(ROLES.console);

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
        live: config.rail === "razorpay",
        label: config.rail === "razorpay" ? "LIVE — Razorpay Test Mode" : "REPLAY — recorded rail",
      },
    }),
  },
  {
    method: "GET",
    path: "/api/summary",
    handler: async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await setMerchantContext(client, config.merchantId);
        const decisions = await client.query<{ reason_code: string; count: string }>(
          `SELECT payload_redacted -> 'payload' ->> 'reason_code' AS reason_code,
                  COUNT(*)::text AS count
             FROM ledger WHERE kind = 'DECISION'
            GROUP BY 1 ORDER BY 2 DESC`,
        );
        await client.query("COMMIT");
        return { status: 200, body: { decisions: decisions.rows } };
      } finally {
        client.release();
      }
    },
  },
]);

await listen(server, Number(process.env.PORT ?? 8083), "web");
