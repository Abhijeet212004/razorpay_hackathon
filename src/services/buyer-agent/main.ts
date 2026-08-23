import { assertNoPaymentCredential } from "../../shared/credentials.js";
import { loadConfig } from "../../shared/config.js";
import { createHttpService, listen } from "../../shared/http.js";

/**
 * The buyer agent. Untrusted by design: separate process, separate environment, no
 * payment credential and no database role.
 *
 * With BRAIN=scripted the planner is deterministic, which is also why the red-team suite
 * needs no model at all — a hostile agent is a script.
 *
 * The tool loop and the MCP client land in Phase 6. What exists now is the process, its
 * health endpoint, and the assertion that it holds nothing it should not.
 */
assertNoPaymentCredential("buyer-agent");

const config = loadConfig();

const server = createHttpService([
  {
    method: "GET",
    path: "/health",
    handler: () => ({
      status: 200,
      body: { ok: true, service: "buyer-agent", brain: config.brain },
    }),
  },
  {
    method: "GET",
    path: "/api/mode",
    handler: () => ({ status: 200, body: { rail: config.rail, brain: config.brain } }),
  },
]);

await listen(server, Number(process.env.PORT ?? 8084), "buyer-agent");
