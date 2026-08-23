import { acpCheckout, approve, confirmPurchase } from "./authorization.controller.js";

/**
 * Routes the guard layer mounts. Rate limiting, Zod validation and taint tagging run as
 * edge middleware ahead of every handler here; the middleware writes the ledger entry on
 * a denial so a handler cannot forget to log one.
 */
export const authorizationRoutes = [
  { method: "POST", path: "/agent/mcp", handler: confirmPurchase },
  { method: "POST", path: "/agent/acp/checkout", handler: acpCheckout },
  { method: "GET", path: "/agent/approve/:challenge", handler: approve },
] as const;
