import { createHash, randomBytes, randomUUID } from "node:crypto";
import { signPayload } from "../../shared/crypto/ed25519.js";
import { taint, type Tainted } from "../../shared/taint.js";
import { intentSigningPayload, type Intent } from "../authorization/authorization.validation.js";

/**
 * The buyer agent's tool loop. Hand-written, under two hundred lines, no framework.
 *
 * The boundary between the model and the system is the product. Delegating it to a
 * third-party abstraction with its own retry, memory and prompt assembly would hide the
 * part a reviewer most wants to read.
 *
 * Two properties matter here, and both are the agent's own discipline rather than
 * something the kernel can enforce:
 *
 *   - The plan is frozen and hashed BEFORE any catalog text is read, so a product
 *     description cannot change what the agent set out to do.
 *   - Every string that comes back from the catalog is tainted at the boundary, so it
 *     cannot be assigned into a field a decision reads.
 *
 * The kernel does not trust either of these. That is the point: if the agent skips both,
 * it still gets one transaction, at an allowlisted merchant, under the silent threshold.
 */

export interface Plan {
  readonly goal: string;
  readonly wanted: readonly string[];
  readonly maxPaise: bigint;
  /** SHA-256 of the plan, computed before the first catalog read. */
  readonly frozenHash: string;
}

export interface CatalogItem {
  readonly sku: Tainted<string>;
  readonly name: Tainted<string>;
  readonly category: Tainted<string>;
  readonly pricePaise: bigint;
}

export interface AgentKeys {
  readonly agentId: string;
  readonly privateKey: Buffer;
}

export interface KernelTransport {
  searchCatalog(query: string): Promise<CatalogItem[]>;
  getQuote(mandateId: string, items: Array<{ sku: string; quantity: number }>): Promise<{
    quote: { quote_id: string; amount_paise: string; basket_hash: string; merchant_id: string };
    kid: string;
    signature: string;
  }>;
  confirm(body: unknown): Promise<{ verdict: string; reason_code: string; audit_url?: string }>;
}

/** Frozen before anything external is read. Nothing downstream may change it. */
export function freezePlan(goal: string, wanted: readonly string[], maxPaise: bigint): Plan {
  const canonical = JSON.stringify({
    goal,
    max_paise: maxPaise.toString(),
    wanted: [...wanted].sort(),
  });
  return {
    goal,
    wanted,
    maxPaise,
    frozenHash: createHash("sha256").update(canonical).digest("hex"),
  };
}

export function planUnchanged(plan: Plan): boolean {
  return freezePlan(plan.goal, plan.wanted, plan.maxPaise).frozenHash === plan.frozenHash;
}

export interface Outcome {
  readonly verdict: string;
  readonly reasonCode: string;
  readonly said: string;
  readonly auditUrl?: string;
}

/**
 * What the user hears. Written from the reason code alone, never from anything the
 * verifier or the kernel reasoned internally.
 */
export function explain(reasonCode: string, detail?: { remainingPaise?: bigint }): string {
  const rupees = (p: bigint) => `₹${(p / 100n).toLocaleString("en-IN")}`;
  switch (reasonCode) {
    case "OK-000":
      return "Ordered.";
    case "STP-001":
      return "That's above your silent limit, so I've asked you to approve it.";
    case "STP-002":
      return "First order at this shop, so I've asked you to approve it.";
    case "LMT-001":
      return "That's more than your per-order limit allows.";
    case "LMT-002":
      return detail?.remainingPaise === undefined
        ? "You've used this month's limit."
        : `${rupees(detail.remainingPaise)} left this month — want me to split the order?`;
    case "LMT-003":
      return "I've hit the limit on how many orders I can place in an hour.";
    case "SCP-001":
      return "I can't buy from that shop — your permission doesn't cover it.";
    case "SCP-002":
      return "I can't buy that — your permission covers groceries and household only.";
    case "MND-002":
      return "My permission to shop here expired. Renew?";
    case "MND-003":
      return "You revoked my permission, so I've stopped.";
    case "SEC-004":
      return "That didn't look like what you asked for, so I stopped.";
    default:
      return "I couldn't place that order.";
  }
}

export async function runPurchase(
  transport: KernelTransport,
  keys: AgentKeys,
  mandateId: string,
  plan: Plan,
): Promise<Outcome> {
  // Everything the catalog returns is tainted at the boundary, before it is looked at.
  const results = (await transport.searchCatalog(plan.wanted.join(" "))).map((item) => ({
    ...item,
    name: taint(item.name),
    category: taint(item.category),
  }));

  // The catalog has now been read. If the plan changed, something in it acted on us.
  if (!planUnchanged(plan)) {
    return {
      verdict: "ABORTED",
      reasonCode: "SEC-001",
      said: "Something in the shop's listings tried to change what I was doing, so I stopped.",
    };
  }

  const basket = plan.wanted
    .map((want) => results.find((item) => String(item.sku).includes(want)))
    .filter((item): item is (typeof results)[number] => item !== undefined)
    .map((item) => ({ sku: String(item.sku), quantity: 1 }));

  if (basket.length === 0) {
    return { verdict: "ABORTED", reasonCode: "NO-MATCH", said: "I couldn't find those items." };
  }

  const signed = await transport.getQuote(mandateId, basket);
  const amount = BigInt(signed.quote.amount_paise);

  // The agent's own ceiling, checked before asking. The kernel checks it again and does
  // not care what the agent decided.
  if (amount > plan.maxPaise) {
    return {
      verdict: "ABORTED",
      reasonCode: "OVER-PLAN",
      said: `That comes to more than the ₹${plan.maxPaise / 100n} you asked me to stay under.`,
    };
  }

  const now = new Date();
  const intent: Intent = {
    intent_id: `int_${randomUUID()}`,
    type: "purchase",
    mandate_id: mandateId,
    quote_id: signed.quote.quote_id,
    merchant_id: signed.quote.merchant_id,
    amount_paise: amount,
    basket_hash: signed.quote.basket_hash,
    // Display only. The compiler refuses a Tainted<string> in any other field.
    rationale: plan.goal,
    nonce: randomBytes(16).toString("hex"),
    expires_at: new Date(now.getTime() + 120_000).toISOString(),
  };

  const signature = signPayload(keys.privateKey, intentSigningPayload(intent));

  const response = await transport.confirm({
    signedIntent: {
      intent: { ...intent, amount_paise: amount.toString() },
      agent_id: keys.agentId,
      signature: signature.toString("hex"),
    },
    signedQuote: signed,
  });

  return {
    verdict: response.verdict,
    reasonCode: response.reason_code,
    said: explain(response.reason_code),
    ...(response.audit_url === undefined ? {} : { auditUrl: response.audit_url }),
  };
}
