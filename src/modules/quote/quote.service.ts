import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { signPayload, verifyPayload } from "../../shared/crypto/ed25519.js";
import { sha256 } from "../../shared/crypto/hash.js";
import { canonicalBytes } from "../../shared/crypto/jcs.js";
import { setMerchantContext } from "../../shared/db/merchant-context.js";
import { paiseToCanonical, type Paise } from "../../shared/money.js";
import * as identity from "../identity/identity.repository.js";
import * as repo from "./quote.repository.js";
import { quoteSigningPayload, type Quote, type SignedQuote } from "./quote.validation.js";

export class UnknownSkuError extends Error {
  constructor(readonly skus: readonly string[]) {
    super(`the catalog has no active item for: ${skus.join(", ")}`);
    this.name = "UnknownSkuError";
  }
}

export class QuoteOutOfScopeError extends Error {
  constructor(
    readonly categories: readonly string[],
    readonly allowed: readonly string[],
  ) {
    super(
      `basket touches ${categories.join(", ")}, mandate grants ${allowed.join(", ")}`,
    );
    this.name = "QuoteOutOfScopeError";
  }
}

export interface PriceBasketInput {
  readonly mandateId: string;
  readonly items: ReadonlyArray<{ sku: string; quantity: number }>;
}

export interface QuoteServiceOptions {
  readonly merchantId: string;
  readonly quoteTtlMs: number;
}

/** Stable regardless of the order the agent listed the items in. */
export function basketHash(
  lines: ReadonlyArray<{ sku: string; quantity: number; pricePaise: Paise }>,
): Buffer {
  const canonical = [...lines]
    .sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0))
    .map((line) => ({
      price_paise: paiseToCanonical(line.pricePaise),
      quantity: line.quantity,
      sku: line.sku,
    }));
  return sha256(canonicalBytes(canonical));
}

/**
 * INV-14: every signed quote names the mandate it was issued to.
 *
 * Prices a basket from the merchant's own catalog and issues a signed, single-use quote
 * bound to one mandate.
 *
 * The scope check here is ergonomics: it refuses an out-of-scope basket before the agent
 * builds an intent around it. The enforcement point of record is the policy engine, which
 * re-checks under the mandate row lock — the mandate could be narrowed between issue and
 * execution.
 */
export async function priceBasket(
  pool: Pool,
  options: QuoteServiceOptions,
  input: PriceBasketInput,
): Promise<SignedQuote> {
  const activeKey = await identity.findActiveKey(pool, "quote");
  if (activeKey === null) throw new Error("no active quote signing key");

  const privateKey = await privateKeyFor(pool, activeKey.kid);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setMerchantContext(client, options.merchantId);

    const mandate = await repo.mandateScope(client, input.mandateId);
    if (mandate === null) throw new Error(`no mandate ${input.mandateId}`);

    const skus = input.items.map((item) => item.sku);
    const catalog = await repo.priceLines(client, options.merchantId, skus);

    const missing = skus.filter((sku) => !catalog.some((line) => line.sku === sku));
    if (missing.length > 0) throw new UnknownSkuError(missing);

    const lines = input.items.map((item) => {
      const entry = catalog.find((line) => line.sku === item.sku)!;
      return {
        sku: item.sku,
        quantity: item.quantity,
        pricePaise: entry.pricePaise,
        category: entry.category,
      };
    });

    const amountPaise = lines.reduce(
      (total, line) => total + line.pricePaise * BigInt(line.quantity),
      0n,
    );
    const categories = [...new Set(lines.map((line) => line.category))].sort();

    const outOfScope = categories.filter((c) => !mandate.allowedCategories.includes(c));
    if (outOfScope.length > 0) {
      throw new QuoteOutOfScopeError(outOfScope, mandate.allowedCategories);
    }

    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + options.quoteTtlMs);
    const hash = basketHash(lines);

    const quote: Quote = {
      quote_id: `qte_${randomUUID()}`,
      mandate_id: input.mandateId,
      merchant_id: options.merchantId,
      basket_hash: hash.toString("hex"),
      amount_paise: amountPaise,
      categories,
      nonce: randomBytes(16).toString("hex"),
      issued_at: issuedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    };

    const signature = signPayload(privateKey, quoteSigningPayload(quote));

    await repo.insert(client, {
      quoteId: quote.quote_id,
      mandateId: quote.mandate_id,
      merchantId: quote.merchant_id,
      basketHash: hash,
      amountPaise,
      categories,
      nonce: quote.nonce,
      issuedAt,
      expiresAt,
      kid: activeKey.kid,
      signature,
      // What was priced, in the merchant's own numbers.
      basket: lines.map((line) => ({
        sku: line.sku,
        quantity: line.quantity,
        pricePaise: line.pricePaise,
      })),
    });

    await client.query("COMMIT");
    return { quote, kid: activeKey.kid, signature: signature.toString("hex") };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Verification accepts retired keys; only issuance is restricted to the active one. */
export async function verifySignature(pool: Pool, signed: SignedQuote): Promise<boolean> {
  const key = await identity.findVerificationKey(pool, signed.kid);
  if (key === null || key.purpose !== "quote") return false;
  return verifyPayload(
    key.publicKey,
    quoteSigningPayload(signed.quote),
    Buffer.from(signed.signature, "hex"),
  );
}

async function privateKeyFor(pool: Pool, kid: string): Promise<Buffer> {
  const result = await pool.query<{ private_key: Buffer | null }>(
    `SELECT private_key FROM signing_keys WHERE kid = $1`,
    [kid],
  );
  const key = result.rows[0]?.private_key;
  if (key === null || key === undefined) throw new Error(`signing key ${kid} has no private material`);
  return key;
}
