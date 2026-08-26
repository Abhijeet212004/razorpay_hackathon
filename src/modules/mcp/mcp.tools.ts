import type { ToolClass } from "../agent/agent.tools.js";

/**
 * The MCP tool schemas.
 *
 * Same tools as the HTTP surface, described in JSON Schema so a model can call them
 * without reading documentation. One surface, two doors.
 *
 * The descriptions matter more than usual here: they are the only instructions the model
 * gets, and a model that misunderstands `orders.status` will retry an ambiguous payment.
 * Each one says what the tool does *and* what not to conclude from it.
 */

export interface McpTool {
  readonly name: string;
  readonly class: ToolClass;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

const str = (description: string) => ({ type: "string", description });
const paise = (description: string) => ({
  type: "string",
  pattern: "^(0|[1-9][0-9]*)$",
  description: `${description} In paise as a decimal string — ₹1 is "100".`,
});

export const MCP_TOOLS: readonly McpTool[] = [
  {
    name: "catalog_search",
    class: "read",
    title: "Search the catalog",
    description:
      "Find products this merchant sells. Prices come from the merchant and cannot be " +
      "influenced by you. Items the merchant has withheld will not appear; that is not " +
      "an error and you should not retry. Pass mandate_id to learn which results the " +
      "shopper's permission actually covers.",
    inputSchema: {
      type: "object",
      properties: {
        query: str("Free text matched against the product name."),
        category: str("Restrict to one category."),
        max_price_paise: paise("Only items at or below this price."),
        min_price_paise: paise("Only items at or above this price."),
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Default 20." },
        mandate_id: str("Optional. Marks each result as in scope or not."),
      },
    },
  },
  {
    name: "catalog_get",
    class: "read",
    title: "Get one product",
    description:
      "One product by sku, as returned by catalog_search. Returns not-found for anything " +
      "the merchant has withheld from agents, which is not an error and should not be " +
      "retried. The price here is the merchant's and is what a quote will use.",
    inputSchema: {
      type: "object",
      required: ["sku"],
      properties: { sku: str("From catalog_search."), mandate_id: str("Optional.") },
    },
  },
  {
    name: "request_permission",
    class: "read",
    title: "Ask the shopper for permission to spend",
    description:
      "Start a consent flow. This returns a URL for a human to open and a reference to " +
      "poll — it does NOT return permission. Nothing is authorised until a person " +
      "completes the flow on that page. Show the URL to the shopper and then poll " +
      "check_permission.",
    inputSchema: {
      type: "object",
      required: ["contact"],
      properties: {
        contact: str("The shopper's phone number, for the one-time code."),
        categories: {
          type: "array",
          items: { type: "string" },
          description: "Categories to request. Ask for the least you need.",
        },
        per_transaction_paise: paise("Most that may be spent in one order."),
        cumulative_paise: paise("Most that may be spent in 30 days."),
        silent_threshold_paise: paise("Above this the shopper is asked each time."),
      },
    },
  },
  {
    name: "check_permission",
    class: "read",
    title: "Check whether permission was granted",
    description:
      "Poll a consent request. Returns granted true or false and, once granted, the " +
      "mandate_id every later call needs. Do not attempt to read the consent page.",
    inputSchema: {
      type: "object",
      required: ["request_ref"],
      properties: { request_ref: str("From request_permission.") },
    },
  },
  {
    name: "check_budget",
    class: "read",
    title: "What is left to spend",
    description:
      "How much of the shopper's limit remains, and the amount above which they are " +
      "asked to approve each purchase. Check this before proposing a large basket so " +
      "you can offer to split it rather than have it refused.",
    inputSchema: {
      type: "object",
      required: ["mandate_id"],
      properties: { mandate_id: str("From check_permission.") },
    },
  },
  {
    name: "get_quote",
    class: "propose",
    title: "Price a basket",
    description:
      "Ask the merchant to price a basket. The merchant does the pricing and signs the " +
      "result. A quote is single use, short lived, and valid only for the mandate it " +
      "names. Getting a quote spends nothing.",
    inputSchema: {
      type: "object",
      required: ["mandate_id", "items"],
      properties: {
        mandate_id: str("From check_permission."),
        items: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["sku", "quantity"],
            properties: {
              sku: str("From catalog_search."),
              quantity: { type: "integer", minimum: 1, maximum: 100 },
            },
          },
        },
      },
    },
  },
  {
    name: "purchase",
    class: "money",
    title: "Buy the basket you were quoted",
    description:
      "Submit a quote for payment. Returns one of three outcomes, each with a single " +
      "reason code:\n" +
      "  ALLOW   — bought.\n" +
      "  STEP_UP — the shopper must approve it. Show them approval_url. This is not a " +
      "failure and must not be retried.\n" +
      "  DENY    — refused. The reason code says why. Do not retry the same request; " +
      "either change it or tell the shopper.\n" +
      "You cannot set the price: the amount comes from the quote.",
    inputSchema: {
      type: "object",
      required: ["quote_id", "reason"],
      properties: {
        quote_id: str("From get_quote."),
        reason: str("Why you are buying this, in the shopper's own words. Display only."),
      },
    },
  },
  {
    name: "order_status",
    class: "read",
    title: "Check an order",
    description:
      "The state of one order. `processing` with `reconciling: true` means the outcome " +
      "is genuinely not yet known and is being resolved by reading the payment rail. " +
      "Do not re-purchase in that state — doing so risks charging the shopper twice.",
    inputSchema: {
      type: "object",
      required: ["mandate_id", "intent_id"],
      properties: { mandate_id: str(""), intent_id: str("From a purchase result.") },
    },
  },
  {
    name: "order_history",
    class: "read",
    title: "Past orders",
    description:
      "Orders placed under this permission, most recent first. Use it to answer \"what " +
      "did I order last time\" and as the basis for a reorder. It shows only orders " +
      "made under this permission, not the shopper's whole history with the merchant.",
    inputSchema: {
      type: "object",
      required: ["mandate_id"],
      properties: {
        mandate_id: str(""),
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: "reorder",
    class: "propose",
    title: "Repeat a past order",
    description:
      "The line items of a past order, so you can quote them again. It does not buy " +
      "anything: prices may have changed and the shopper's limits are checked afresh.",
    inputSchema: {
      type: "object",
      required: ["mandate_id", "intent_id"],
      properties: { mandate_id: str(""), intent_id: str("") },
    },
  },
  {
    name: "cancel_order",
    class: "money",
    title: "Cancel before it is paid",
    description:
      "Cancel an order that has not yet been paid. Once a payment has gone through this " +
      "will refuse — that needs a refund, which is a different permission the merchant " +
      "may not have enabled.",
    inputSchema: {
      type: "object",
      required: ["mandate_id", "intent_id"],
      properties: { mandate_id: str(""), intent_id: str("") },
    },
  },
];

export function toolsFor(exposed: readonly ToolClass[]): readonly McpTool[] {
  return MCP_TOOLS.filter((tool) => exposed.includes(tool.class));
}
