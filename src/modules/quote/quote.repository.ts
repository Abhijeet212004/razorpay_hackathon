import type { Paise } from "../../shared/money.js";
import type { PoolClient } from "pg";

export interface QuoteRow {
  quoteId: string;
  mandateId: string;
  merchantId: string;
  amountPaise: Paise;
  categories: readonly string[];
  basketHash: Buffer;
  expiresAt: Date;
  consumedAt: Date | null;
}

export async function findById(
  client: PoolClient,
  quoteId: string,
): Promise<QuoteRow | null> {
  const result = await client.query<{
    quote_id: string;
    mandate_id: string;
    merchant_id: string;
    amount_paise: string;
    categories: string[];
    basket_hash: Buffer;
    expires_at: Date;
    consumed_at: Date | null;
  }>(
    `SELECT quote_id, mandate_id, merchant_id, amount_paise::text, categories,
            basket_hash, expires_at, consumed_at
       FROM quotes
      WHERE quote_id = $1`,
    [quoteId],
  );

  const row = result.rows[0];
  if (row === undefined) return null;

  return {
    quoteId: row.quote_id,
    mandateId: row.mandate_id,
    merchantId: row.merchant_id,
    amountPaise: BigInt(row.amount_paise),
    categories: row.categories,
    basketHash: row.basket_hash,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

/**
 * Single-use enforcement, run inside the mandate lock. Returns false when the quote was
 * already consumed. The WHERE clause is what makes it single-use, not the read that
 * preceded it.
 */
export async function consume(
  client: PoolClient,
  quoteId: string,
  intentId: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE quotes
        SET consumed_at = now(), consumed_by = $2
      WHERE quote_id = $1 AND consumed_at IS NULL`,
    [quoteId, intentId],
  );
  return result.rowCount === 1;
}

export interface CatalogLine {
  sku: string;
  name: string;
  category: string;
  pricePaise: Paise;
}

/** Prices come from the merchant's own catalog. The agent never supplies one. */
export async function priceLines(
  client: PoolClient,
  merchantId: string,
  skus: readonly string[],
): Promise<CatalogLine[]> {
  const result = await client.query<{
    sku: string;
    name: string;
    category: string;
    price_paise: string;
  }>(
    `SELECT sku, name, category, price_paise::text
       FROM catalog_items
      WHERE merchant_id = $1 AND sku = ANY($2::text[]) AND active`,
    [merchantId, [...skus]],
  );
  return result.rows.map((row) => ({
    sku: row.sku,
    name: row.name,
    category: row.category,
    pricePaise: BigInt(row.price_paise),
  }));
}

export interface QuoteLine {
  sku: string;
  quantity: number;
  pricePaise: Paise;
}

export interface NewQuote {
  quoteId: string;
  mandateId: string;
  merchantId: string;
  basketHash: Buffer;
  amountPaise: Paise;
  categories: readonly string[];
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
  kid: string;
  signature: Buffer;
  basket: readonly QuoteLine[];
}

export async function insert(client: PoolClient, quote: NewQuote): Promise<void> {
  await client.query(
    `INSERT INTO quotes (
       quote_id, mandate_id, merchant_id, basket_hash, amount_paise, categories,
       nonce, issued_at, expires_at, kid, signature, basket
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
    [
      quote.quoteId,
      quote.mandateId,
      quote.merchantId,
      quote.basketHash,
      quote.amountPaise.toString(),
      [...quote.categories],
      quote.nonce,
      quote.issuedAt.toISOString(),
      quote.expiresAt.toISOString(),
      quote.kid,
      quote.signature,
      JSON.stringify(
        quote.basket.map((line) => ({
          sku: line.sku,
          quantity: line.quantity,
          price_paise: line.pricePaise.toString(),
        })),
      ),
    ],
  );
}

/** What a past quote priced, so a reorder reprices the same items. */
export async function basketFor(
  client: PoolClient,
  intentId: string,
): Promise<Array<{ sku: string; quantity: number }>> {
  const result = await client.query<{ basket: Array<{ sku: string; quantity: number }> }>(
    `SELECT basket FROM quotes WHERE consumed_by = $1`,
    [intentId],
  );
  return result.rows[0]?.basket ?? [];
}

export interface MandateScopeRow {
  mandateId: string;
  merchantId: string;
  state: string;
  allowedCategories: readonly string[];
  allowedMerchants: readonly string[];
}

export async function mandateScope(
  client: PoolClient,
  mandateId: string,
): Promise<MandateScopeRow | null> {
  const result = await client.query<{
    mandate_id: string;
    merchant_id: string;
    state: string;
    scope: { merchants?: unknown; categories?: unknown };
  }>(`SELECT mandate_id, merchant_id, state, scope FROM mandates WHERE mandate_id = $1`, [
    mandateId,
  ]);
  const row = result.rows[0];
  if (row === undefined) return null;
  const arr = (v: unknown): readonly string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    mandateId: row.mandate_id,
    merchantId: row.merchant_id,
    state: row.state,
    allowedCategories: arr(row.scope?.categories),
    allowedMerchants: arr(row.scope?.merchants),
  };
}
