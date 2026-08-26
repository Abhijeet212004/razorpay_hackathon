import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { signPayload } from "../../shared/crypto/ed25519.js";
import { setMerchantContext } from "../../shared/db/merchant-context.js";
import { silentLogger, type Logger } from "../../shared/logger.js";
import type { ToolClass } from "../agent/agent.tools.js";
import { authorize, type KernelContext } from "../authorization/authorization.service.js";
import { intentSigningPayload } from "../authorization/authorization.validation.js";
import * as catalog from "../catalog/catalog.service.js";
import { CatalogSearchSchema } from "../catalog/catalog.validation.js";
import {
  consentStatus,
  requestConsent,
  type ConsentOptions,
} from "../consent/consent.service.js";
import * as orders from "../orders/orders.service.js";
import { priceBasket, QuoteOutOfScopeError, UnknownSkuError } from "../quote/quote.service.js";
import type { SignedQuote } from "../quote/quote.validation.js";
import type { McpSession } from "./mcp.session.js";
import { toolsFor } from "./mcp.tools.js";

/**
 * Tool dispatch.
 *
 * Every handler validates its arguments before touching anything, and every money-moving
 * one goes through the same authorisation sequence the HTTP surface uses. There is no
 * shortcut here for being MCP — the transport changed, the gate did not.
 */

export interface McpOptions {
  readonly merchantId: string;
  readonly publicBaseUrl: string;
  /** Which classes this merchant has chosen to expose. Money can be withheld entirely. */
  readonly exposed: readonly ToolClass[];
  readonly consent: ConsentOptions;
  readonly logger?: Logger;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function text(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function problem(message: string, detail?: Record<string, unknown>): ToolResult {
  // An error a model reads is an instruction. It says what to do next, never why
  // internally — a reason a caller can probe is a reason a caller can tune against.
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message, ...detail }, null, 2) }],
    isError: true,
  };
}

/**
 * Quotes issued in this session, so `purchase` can name one by id without the model
 * having to carry a signature around. The signed quote never leaves the server.
 */
const quoteCache = new Map<string, { signed: SignedQuote; mandateId: string; at: number }>();
const QUOTE_CACHE_TTL_MS = 15 * 60_000;

function remember(sessionId: string, quoteId: string, signed: SignedQuote, mandateId: string) {
  for (const [key, value] of quoteCache) {
    if (Date.now() - value.at > QUOTE_CACHE_TTL_MS) quoteCache.delete(key);
  }
  quoteCache.set(`${sessionId}:${quoteId}`, { signed, mandateId, at: Date.now() });
}

export async function callTool(
  pool: Pool,
  kernel: KernelContext,
  options: McpOptions,
  session: McpSession,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const logger = options.logger ?? silentLogger;
  const tool = toolsFor(options.exposed).find((t) => t.name === name);

  if (tool === undefined) {
    // Withheld and non-existent are the same answer: a caller should not be able to map
    // which capabilities a merchant chose not to expose.
    return problem("no such tool", { tool: name });
  }

  const catalogOptions = { merchantId: options.merchantId };
  const orderOptions = { merchantId: options.merchantId };

  try {
    switch (name) {
      case "catalog_search": {
        const parsed = CatalogSearchSchema.safeParse(args);
        if (!parsed.success) return problem("invalid arguments", { detail: parsed.error.issues });
        const result = await catalog.search(
          pool,
          catalogOptions,
          parsed.data,
          typeof args.mandate_id === "string" ? args.mandate_id : undefined,
        );
        return text(result);
      }

      case "catalog_get": {
        const sku = z.string().min(1).safeParse(args.sku);
        if (!sku.success) return problem("sku is required");
        const item = await catalog.getItem(
          pool,
          catalogOptions,
          sku.data,
          typeof args.mandate_id === "string" ? args.mandate_id : undefined,
        );
        return item === null
          ? problem("no such product", { recoverable: true })
          : text(item);
      }

      case "request_permission": {
        const contact = z.string().regex(/^\+?[0-9]{10,15}$/).safeParse(args.contact);
        if (!contact.success) return problem("a valid phone number is required");

        const consent = await requestConsent(pool, options.consent, {
          agent_id: session.agentId,
          contact: contact.data,
          requested_scope: {
            merchants: [options.merchantId],
            categories: Array.isArray(args.categories) && args.categories.length > 0
              ? (args.categories as string[])
              : ["groceries", "household"],
            currency: "INR",
          },
          limits: {
            per_transaction_paise: String(args.per_transaction_paise ?? "500000"),
            cumulative_paise: String(args.cumulative_paise ?? "1500000"),
            silent_threshold_paise: String(args.silent_threshold_paise ?? "50000"),
            velocity_per_hour: 10,
          },
        });

        return text({
          request_ref: consent.requestRef,
          consent_url: `${options.publicBaseUrl}/consent/${consent.requestRef}`,
          granted: false,
          next: "Show consent_url to the shopper, then poll check_permission.",
        });
      }

      case "check_permission": {
        const ref = z.string().min(1).safeParse(args.request_ref);
        if (!ref.success) return problem("request_ref is required");
        const status = await consentStatus(pool, options.consent, ref.data);
        return status === null
          ? problem("no such request")
          : text({
              granted: status.state === "granted",
              state: status.state,
              mandate_id: status.mandateId,
            });
      }

      case "check_budget": {
        const mandateId = z.string().min(1).safeParse(args.mandate_id);
        if (!mandateId.success) return problem("mandate_id is required");
        const view = await orders.spendRemaining(pool, orderOptions, mandateId.data);
        return view === null ? problem("no such permission") : text(view);
      }

      case "get_quote": {
        const parsed = z
          .object({
            mandate_id: z.string().min(1),
            items: z
              .array(z.object({ sku: z.string().min(1), quantity: z.number().int().min(1).max(100) }))
              .min(1)
              .max(30),
          })
          .safeParse(args);
        if (!parsed.success) return problem("invalid arguments", { detail: parsed.error.issues });

        const signed = await priceBasket(
          pool,
          { merchantId: options.merchantId, quoteTtlMs: kernel.config.quoteTtlMs },
          { mandateId: parsed.data.mandate_id, items: parsed.data.items },
        );
        // Held server-side. The model names a quote by id; it never handles a signature.
        remember(session.sessionId, signed.quote.quote_id, signed, parsed.data.mandate_id);

        return text({
          quote_id: signed.quote.quote_id,
          amount_paise: signed.quote.amount_paise.toString(),
          categories: signed.quote.categories,
          expires_at: signed.quote.expires_at,
          next: "Call purchase with this quote_id.",
        });
      }

      case "purchase": {
        const parsed = z
          .object({ quote_id: z.string().min(1), reason: z.string().min(1).max(2000) })
          .safeParse(args);
        if (!parsed.success) return problem("quote_id and reason are required");

        const held = quoteCache.get(`${session.sessionId}:${parsed.data.quote_id}`);
        if (held === undefined) {
          return problem("that quote is not available — get a fresh one", { recoverable: true });
        }

        const q = held.signed.quote;
        const intent = {
          intent_id: `int_${randomUUID()}`,
          type: "purchase" as const,
          mandate_id: held.mandateId,
          quote_id: q.quote_id,
          merchant_id: q.merchant_id,
          amount_paise: q.amount_paise,
          basket_hash: q.basket_hash,
          // Display only. No rule can read it.
          rationale: parsed.data.reason,
          nonce: randomBytes(16).toString("hex"),
          expires_at: new Date(Date.now() + 120_000).toISOString(),
        };

        // The kernel signs for the session, because an MCP client cannot. The signature
        // proves which agent asked; it grants nothing that the mandate has not already.
        const signature = signPayload(session.privateKey, intentSigningPayload(intent)).toString("hex");

        const decision = await authorize(kernel, {
          signedIntent: { intent, agent_id: session.agentId, signature },
          signedQuote: held.signed,
        });

        quoteCache.delete(`${session.sessionId}:${parsed.data.quote_id}`);
        logger.count(`mcp.purchase.${decision.verdict.toLowerCase()}`);

        return text({
          verdict: decision.verdict,
          reason_code: decision.reason_code,
          intent_id: decision.intent_id,
          amount_paise: q.amount_paise.toString(),
          ...(decision.challenge_id === null
            ? {}
            : {
                approval_url: `${options.publicBaseUrl}/agent/approve/${decision.challenge_id}`,
                next: "Show approval_url to the shopper. Do not retry this purchase.",
              }),
          ...(decision.verdict === "DENY"
            ? { next: "Do not retry. Change the request or tell the shopper." }
            : {}),
          audit_url: `${options.publicBaseUrl}/agent/audit/${decision.intent_id}`,
        });
      }

      case "order_status": {
        const parsed = z
          .object({ mandate_id: z.string().min(1), intent_id: z.string().min(1) })
          .safeParse(args);
        if (!parsed.success) return problem("mandate_id and intent_id are required");
        const view = await orders.status(
          pool,
          orderOptions,
          parsed.data.mandate_id,
          parsed.data.intent_id,
        );
        return view === null ? problem("no such order") : text(view);
      }

      case "order_history": {
        const mandateId = z.string().min(1).safeParse(args.mandate_id);
        if (!mandateId.success) return problem("mandate_id is required");
        const list = await orders.history(
          pool,
          orderOptions,
          mandateId.data,
          typeof args.limit === "number" ? args.limit : 20,
        );
        return text({ orders: list });
      }

      case "reorder": {
        const parsed = z
          .object({ mandate_id: z.string().min(1), intent_id: z.string().min(1) })
          .safeParse(args);
        if (!parsed.success) return problem("mandate_id and intent_id are required");
        const items = await orders.reorderBasket(pool, orderOptions, parsed.data.intent_id);
        return text({
          items,
          next: "Call get_quote with these items. Prices and limits are checked afresh.",
        });
      }

      case "cancel_order": {
        const parsed = z
          .object({ mandate_id: z.string().min(1), intent_id: z.string().min(1) })
          .safeParse(args);
        if (!parsed.success) return problem("mandate_id and intent_id are required");
        const outcome = await orders.cancel(
          pool,
          orderOptions,
          parsed.data.mandate_id,
          parsed.data.intent_id,
        );
        return outcome.kind === "CANCELLED" ? text(outcome) : problem(
          outcome.kind === "NOT_FOUND" ? "no such order" : (outcome as { reason: string }).reason,
        );
      }

      default:
        return problem("no such tool", { tool: name });
    }
  } catch (error) {
    if (error instanceof UnknownSkuError) {
      return problem("I can't find that item", { skus: error.skus, recoverable: true });
    }
    if (error instanceof QuoteOutOfScopeError) {
      return problem(
        `that is outside what the shopper permitted — they allowed ${error.allowed.join(" and ")}`,
        { reason_code: "SCP-002", recoverable: true },
      );
    }
    logger.error(`mcp tool ${name} failed`, error);
    logger.count("mcp.tool.error");
    // Never the message: it can carry internal detail and a caller has no use for it.
    return problem("that did not work");
  }
}

/** Used by the consent handler to scope reads. Kept here so the module owns its context. */
export async function withMerchant<T>(
  pool: Pool,
  merchantId: string,
  fn: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setMerchantContext(client, merchantId);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } finally {
    client.release();
  }
}
