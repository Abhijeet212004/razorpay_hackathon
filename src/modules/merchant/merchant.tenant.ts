import type { Pool } from "pg";
import { resolveByApiKey, resolveByFulfilToken } from "./merchant.repository.js";
import type { RequestContext } from "../../shared/http.js";

/**
 * Which merchant is this request for?
 *
 * The answer comes from a presented credential and nothing else. An agent cannot name a
 * merchant — if it could, it would be choosing whose limits bind it, whose catalogue it
 * sees and whose money is at stake. There is deliberately no field, header or body
 * parameter that carries a merchant id inward.
 *
 * A deployment serving one merchant may set MERCHANT_ID and skip keys entirely; that is
 * the self-hosted and demo case. A hosted deployment sets no MERCHANT_ID, and then a
 * request without a recognised key resolves to nothing rather than to somebody.
 */

export interface TenantOptions {
  readonly pool: Pool;
  /** The single tenant this deployment serves, if it serves only one. */
  readonly defaultMerchantId: string | null;
}

export type TenantOutcome =
  | { kind: "TENANT"; merchantId: string }
  | { kind: "NO_CREDENTIAL" }
  | { kind: "UNKNOWN_CREDENTIAL" }
  | { kind: "SUSPENDED"; merchantId: string };

function bearer(ctx: RequestContext): string | undefined {
  const raw = ctx.headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1];
}

function header(ctx: RequestContext, name: string): string | undefined {
  const raw = ctx.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/** For agent-facing routes: an API key decides the tenant. */
export async function resolveAgentTenant(
  options: TenantOptions,
  ctx: RequestContext,
): Promise<TenantOutcome> {
  const key = bearer(ctx) ?? header(ctx, "x-agentkit-key");

  if (key === undefined || key.length === 0) {
    return options.defaultMerchantId === null
      ? { kind: "NO_CREDENTIAL" }
      : { kind: "TENANT", merchantId: options.defaultMerchantId };
  }

  const outcome = await resolveByApiKey(options.pool, key);
  if (outcome.kind === "RESOLVED") return { kind: "TENANT", merchantId: outcome.merchantId };
  if (outcome.kind === "SUSPENDED") return { kind: "SUSPENDED", merchantId: outcome.merchantId };
  return { kind: "UNKNOWN_CREDENTIAL" };
}

/** For the merchant's own server-to-server calls, which present a different secret. */
export async function resolveMerchantTenant(
  options: TenantOptions,
  ctx: RequestContext,
): Promise<TenantOutcome> {
  const token = header(ctx, "x-agentkit-token");

  if (token === undefined || token.length === 0) {
    return options.defaultMerchantId === null
      ? { kind: "NO_CREDENTIAL" }
      : { kind: "TENANT", merchantId: options.defaultMerchantId };
  }

  const outcome = await resolveByFulfilToken(options.pool, token);
  if (outcome.kind === "RESOLVED") return { kind: "TENANT", merchantId: outcome.merchantId };
  if (outcome.kind === "SUSPENDED") return { kind: "SUSPENDED", merchantId: outcome.merchantId };
  return { kind: "UNKNOWN_CREDENTIAL" };
}

/** What a refused request is told. Never which merchant a key belongs to. */
export function refusal(outcome: Exclude<TenantOutcome, { kind: "TENANT" }>): {
  status: number;
  body: unknown;
} {
  switch (outcome.kind) {
    case "SUSPENDED":
      return { status: 403, body: { error: "merchant_suspended", reason_code: "SYS-003" } };
    case "UNKNOWN_CREDENTIAL":
      // Deliberately identical to a missing one: probing must not distinguish a wrong key
      // from no key, or the endpoint becomes an oracle for guessing them.
      return { status: 401, body: { error: "unauthorised" } };
    default:
      return { status: 401, body: { error: "unauthorised" } };
  }
}
