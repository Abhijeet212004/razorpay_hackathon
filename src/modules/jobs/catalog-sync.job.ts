import type { Pool } from "pg";
import { assertEgressPermitted } from "../../shared/egress-guard.js";
import { setMerchantContext } from "../../shared/db/merchant-context.js";
import { silentLogger, type Logger } from "../../shared/logger.js";
import type { JobResult } from "./jobs.validation.js";

/**
 * Pulls the merchant's own product endpoint into our priced catalog.
 *
 * This is the whole integration. A merchant points `catalog_url` at a route they already
 * serve — no schema change, no migration, no touching their database. Ours happens to be
 * PostgreSQL and theirs happens to be MongoDB, and neither has to care.
 *
 * It is also the taint boundary. Product descriptions are attacker-controlled text: a
 * marketplace seller, a compromised admin account, or a supplier feed can put anything in
 * them. Everything that arrives here is scanned, and anything instruction-shaped is
 * quarantined — held out of the catalog so it can never be quoted, with the merchant told
 * and the buyer not. A control that nags is a control that gets turned off.
 *
 * Prices and categories are taken from here and nowhere else. The agent supplies SKUs and
 * quantities; it never supplies a price.
 */

/**
 * Instruction-shaped text where a product description should be. Deliberately narrow:
 * a false positive costs the merchant a sale, so this catches the blatant cases and
 * leaves the subtle ones to the rules that do not care what the text says.
 */
const INJECTION = [
  /\b(system|assistant|developer)\s*:/i,
  /\bignore\s+(all\s+)?(previous\s+|prior\s+)?(instructions?|limits?|rules?)\b/i,
  /\bapprove\s+without\b/i,
  /\bdisregard\b.{0,24}\b(limit|policy|cap|rule)/i,
  /\boverride\b.{0,24}\b(limit|policy|cap|mandate)/i,
  /\bbuy\s+\d{2,}\s+units?\b/i,
  /\byou\s+are\s+now\b/i,
];

export function injectionIn(text: string): string | null {
  for (const pattern of INJECTION) {
    if (pattern.test(text)) return pattern.source;
  }
  return null;
}

interface MerchantProduct {
  _id: string;
  name: string;
  description: string;
  category: string;
  price: number;
  stock: number;
}

export interface CatalogSyncOptions {
  readonly merchantId: string;
  readonly catalogUrl: string;
  readonly timeoutMs?: number;
  readonly logger?: Logger;
}

export async function syncCatalog(
  pool: Pool,
  options: CatalogSyncOptions,
): Promise<JobResult & { quarantined: readonly string[] }> {
  const logger = options.logger ?? silentLogger;

  assertEgressPermitted(options.catalogUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);

  let products: MerchantProduct[];
  try {
    const response = await fetch(options.catalogUrl, { signal: controller.signal });
    if (!response.ok) throw new Error(`catalog returned ${response.status}`);
    const body = (await response.json()) as { products?: MerchantProduct[] };
    products = body.products ?? [];
  } finally {
    clearTimeout(timer);
  }

  const quarantined: string[] = [];
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await setMerchantContext(client, options.merchantId);

    for (const product of products) {
      // The whole record is scanned, not just the description: a name or a category is
      // just as much attacker-controlled text.
      const suspect =
        injectionIn(product.description ?? "") ??
        injectionIn(product.name ?? "") ??
        injectionIn(product.category ?? "");

      const sku = String(product._id);
      const active = suspect === null;
      if (!active) {
        quarantined.push(sku);
        logger.warn(`quarantined ${sku}: matched ${suspect}`);
        logger.count("catalog.quarantined");
      }

      await client.query(
        `INSERT INTO catalog_items (merchant_id, sku, name, category, price_paise, active)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (merchant_id, sku) DO UPDATE SET
           name = EXCLUDED.name,
           category = EXCLUDED.category,
           price_paise = EXCLUDED.price_paise,
           active = EXCLUDED.active`,
        [
          options.merchantId,
          sku,
          product.name,
          (product.category ?? "uncategorised").toLowerCase(),
          // Rupees to paise, as an integer. Never a float.
          String(BigInt(Math.round(Number(product.price ?? 0) * 100))),
          active,
        ],
      );
    }

    // Anything no longer in the merchant's feed is deactivated rather than deleted. A
    // product withdrawn from sale must stop being quotable, and the rows stay so a past
    // decision that referenced it can still be read back.
    const live = products.map((p) => String(p._id));
    const withdrawn = await client.query<{ sku: string }>(
      `UPDATE catalog_items SET active = false
        WHERE merchant_id = $1 AND active AND NOT (sku = ANY($2::text[]))
        RETURNING sku`,
      [options.merchantId, live],
    );
    if (withdrawn.rows.length > 0) {
      logger.warn(`deactivated ${withdrawn.rows.length} withdrawn product(s)`);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  return {
    job: "catalog-sync",
    examined: products.length,
    changed: products.length,
    details: products.map((p) => String(p._id)),
    quarantined,
  };
}
