/**
 * The tool manifest — what an agent may call, and what each call costs.
 *
 * An agent that cannot discover the tools cannot use them, so this is served at
 * /agent/tools and is the same list MCP exposes. One surface, two doors.
 *
 * `class` is the important column. It is not documentation: it is the permission level a
 * merchant configures, and the reason the list can grow without the blast radius growing
 * with it.
 *
 *   read      costs nothing, returns tainted merchant text, always available
 *   propose   costs nothing, because a proposal is only words
 *   money     spends the customer's money, always through the policy engine
 *   margin    spends the merchant's margin, bounded by the promo budget
 */

export type ToolClass = "read" | "propose" | "money" | "margin";

export interface ToolDefinition {
  readonly name: string;
  readonly class: ToolClass;
  readonly description: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly input: Readonly<Record<string, string>>;
  /** Reason codes this tool can return, so an agent can handle them deliberately. */
  readonly denials?: readonly string[];
}

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: "consent.request",
    class: "read",
    description:
      "Ask a human for permission to spend. Returns a reference and a URL, never a " +
      "mandate — nothing is authorised until a person completes the flow.",
    method: "POST",
    path: "/consent/request",
    input: {
      agent_id: "string, from register",
      contact: "string, the shopper's phone number",
      requested_scope: "{ merchants, categories, currency }",
      limits: "{ per_transaction_paise, cumulative_paise, silent_threshold_paise, velocity_per_hour }",
    },
  },
  {
    name: "consent.status",
    class: "read",
    description:
      "Whether a consent request has been decided, and the mandate id if it was granted. " +
      "Poll this rather than reading the human's screen.",
    method: "GET",
    path: "/consent/:request_ref/status",
    input: { request_ref: "string, from consent.request" },
  },
  {
    name: "catalog.search",
    class: "read",
    description:
      "Find products this merchant sells. Returns only items the merchant has not " +
      "withheld. Prices are the merchant's own and cannot be influenced by the caller.",
    method: "POST",
    path: "/agent/catalog/search",
    input: {
      query: "string, optional — free text matched against the product name",
      category: "string, optional",
      max_price_paise: "integer string, optional",
      min_price_paise: "integer string, optional",
      limit: "integer, optional, at most 50",
      mandate_id: "string, optional — supply it to learn which results are in scope",
    },
  },
  {
    name: "catalog.get",
    class: "read",
    description: "One product by sku.",
    method: "GET",
    path: "/agent/catalog/:sku",
    input: { sku: "string, from catalog.search" },
  },
  {
    name: "mandate.status",
    class: "read",
    description:
      "What this mandate has left to spend, and the amount above which a human is asked. " +
      "Use it to split an order rather than have one refused.",
    method: "GET",
    path: "/agent/mandate/:mandate_id",
    input: { mandate_id: "string" },
  },
  {
    name: "orders.history",
    class: "read",
    description: "Past orders placed under this mandate, most recent first.",
    method: "POST",
    path: "/agent/orders/history",
    input: { mandate_id: "string", limit: "integer, optional, at most 50" },
  },
  {
    name: "orders.status",
    class: "read",
    description:
      "One order. While an outcome is genuinely unknown it reports `processing` and " +
      "`reconciling: true` — do not retry it, it is being resolved by reading the rail.",
    method: "POST",
    path: "/agent/orders/status",
    input: { mandate_id: "string", intent_id: "string" },
  },
  {
    name: "orders.reorder",
    class: "propose",
    description:
      "The line items of a past order, so they can be quoted again at today's prices. " +
      "Yesterday's approval buys nothing today: the new quote faces every check afresh.",
    method: "POST",
    path: "/agent/orders/reorder",
    input: { mandate_id: "string", intent_id: "string" },
  },
  {
    name: "quote",
    class: "propose",
    description:
      "Price a basket. The merchant's server does the pricing and signs the result, " +
      "binding it to one mandate. Quotes are single use and short lived.",
    method: "POST",
    path: "/agent/quote",
    input: { mandate_id: "string", items: "[{ sku, quantity }]" },
    denials: ["SCP-002", "unknown_sku"],
  },
  {
    name: "purchase",
    class: "money",
    description:
      "Submit a signed intent against a signed quote. Returns ALLOW, DENY or STEP_UP " +
      "with exactly one reason code. A STEP_UP is not a failure — a human is being asked.",
    method: "POST",
    path: "/agent/acp/checkout",
    input: { signedIntent: "SignedIntent", signedQuote: "SignedQuote" },
    denials: [
      "INT-001", "INT-002", "INT-003", "INT-004",
      "MND-001", "MND-002", "MND-003",
      "LMT-001", "LMT-002", "LMT-003",
      "SCP-001", "SCP-002",
      "SEC-002", "SEC-004",
      "SYS-001", "SYS-002", "SYS-003",
      "STP-001", "STP-002",
    ],
  },
  {
    name: "orders.cancel",
    class: "money",
    description:
      "Cancel before the money moves. After capture there is nothing to cancel — there " +
      "is a payment to refund, which is a different permission.",
    method: "POST",
    path: "/agent/orders/cancel",
    input: { mandate_id: "string", intent_id: "string" },
  },
];

/** What the manifest looks like on the wire. */
export function toolManifest(baseUrl: string): unknown {
  return {
    version: "1",
    transports: ["http", "mcp"],
    base_url: baseUrl,
    // Stated up front so an agent developer does not discover it at the first denial.
    principles: [
      "The agent proposes; the kernel authorises. No tool call moves money by itself.",
      "Prices come from the merchant, never from the caller.",
      "A quote names the mandate it was issued to and is single use.",
      "Every decision returns exactly one reason code and is written to an append-only ledger.",
    ],
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      class: tool.class,
      description: tool.description,
      method: tool.method,
      path: tool.path,
      input: tool.input,
      ...(tool.denials === undefined ? {} : { denials: tool.denials }),
    })),
  };
}
