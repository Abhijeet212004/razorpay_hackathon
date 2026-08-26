import type { Pool } from "pg";
import { setMerchantContext } from "../../shared/db/merchant-context.js";
import { paiseToCanonical } from "../../shared/money.js";
import { taint } from "../../shared/taint.js";
import * as repo from "./catalog.repository.js";
import type {
  CatalogItemView,
  CatalogRow,
  CatalogSearchInput,
  CatalogSearchResult,
} from "./catalog.validation.js";

/**
 * Discovery. An agent that cannot find a product cannot buy one, so this is the first
 * thing any external agent calls.
 *
 * It is deliberately a read with no side effects and no rate-limited cost: browsing is
 * free precisely because buying is not. Nothing here consults a mandate's caps — an agent
 * is allowed to look at things it cannot afford, and find out why at the quote.
 */

export interface CatalogOptions {
  readonly merchantId: string;
}

async function scoped<T>(
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
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Every string leaving here is branded, so it cannot reach a decision-bearing field. */
function toView(row: CatalogRow, allowed: readonly string[]): CatalogItemView {
  return {
    sku: row.sku,
    name: taint(row.name),
    category: taint(row.category),
    price_paise: paiseToCanonical(row.pricePaise),
    // Told up front, so an agent does not build a basket it cannot buy. This is
    // ergonomics — the policy engine checks scope again under the lock regardless.
    in_scope: allowed.length === 0 || allowed.includes(row.category),
  };
}

export async function search(
  pool: Pool,
  options: CatalogOptions,
  input: CatalogSearchInput,
  mandateId?: string,
): Promise<CatalogSearchResult> {
  return scoped(pool, options.merchantId, async (client) => {
    const allowed =
      mandateId === undefined ? [] : await repo.allowedCategories(client, mandateId);

    const rows = await repo.search(client, options.merchantId, {
      ...(input.query === undefined ? {} : { query: input.query }),
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(input.max_price_paise === undefined ? {} : { maxPricePaise: input.max_price_paise }),
      ...(input.min_price_paise === undefined ? {} : { minPricePaise: input.min_price_paise }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });

    return {
      items: rows.map((row) => toView(row, allowed)),
      total: rows.length,
      allowed_categories: allowed,
    };
  });
}

export async function getItem(
  pool: Pool,
  options: CatalogOptions,
  sku: string,
  mandateId?: string,
): Promise<CatalogItemView | null> {
  return scoped(pool, options.merchantId, async (client) => {
    const allowed =
      mandateId === undefined ? [] : await repo.allowedCategories(client, mandateId);
    const row = await repo.getItem(client, options.merchantId, sku);
    return row === null ? null : toView(row, allowed);
  });
}
