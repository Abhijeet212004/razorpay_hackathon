import type { PoolClient } from "pg";
import type { Paise } from "../../shared/money.js";
import type { CatalogRow } from "./catalog.validation.js";

/**
 * Only active items are visible. Anything quarantined at sync is absent, and the agent is
 * never told why — a control that explains itself to an attacker is a control being tuned
 * against.
 *
 * Row level security scopes every query to one merchant, so a search cannot reach across
 * tenants whatever the parameters say.
 */
export async function search(
  client: PoolClient,
  merchantId: string,
  options: {
    query?: string;
    category?: string;
    maxPricePaise?: Paise;
    minPricePaise?: Paise;
    limit?: number;
  },
): Promise<CatalogRow[]> {
  const result = await client.query<{
    sku: string;
    name: string;
    category: string;
    price_paise: string;
  }>(
    `SELECT sku, name, category, price_paise::text
       FROM catalog_items
      WHERE merchant_id = $1
        AND active
        AND ($2::text IS NULL OR name ILIKE '%' || $2 || '%')
        AND ($3::text IS NULL OR category = lower($3))
        AND ($4::bigint IS NULL OR price_paise <= $4)
        AND ($5::bigint IS NULL OR price_paise >= $5)
      ORDER BY price_paise
      LIMIT $6`,
    [
      merchantId,
      options.query ?? null,
      options.category ?? null,
      options.maxPricePaise?.toString() ?? null,
      options.minPricePaise?.toString() ?? null,
      Math.min(options.limit ?? 20, 50),
    ],
  );

  return result.rows.map((row) => ({
    sku: row.sku,
    name: row.name,
    category: row.category,
    pricePaise: BigInt(row.price_paise),
  }));
}

export async function getItem(
  client: PoolClient,
  merchantId: string,
  sku: string,
): Promise<CatalogRow | null> {
  const result = await client.query<{
    sku: string;
    name: string;
    category: string;
    price_paise: string;
  }>(
    `SELECT sku, name, category, price_paise::text
       FROM catalog_items
      WHERE merchant_id = $1 AND sku = $2 AND active`,
    [merchantId, sku],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        sku: row.sku,
        name: row.name,
        category: row.category,
        pricePaise: BigInt(row.price_paise),
      };
}

/** The categories this mandate may buy, so an agent can filter before it asks. */
export async function allowedCategories(
  client: PoolClient,
  mandateId: string,
): Promise<readonly string[]> {
  const result = await client.query<{ categories: unknown }>(
    `SELECT scope -> 'categories' AS categories FROM mandates WHERE mandate_id = $1`,
    [mandateId],
  );
  const value = result.rows[0]?.categories;
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
