import { z } from "zod";
import { PaiseSchema, type Paise } from "../../shared/money.js";
import type { Tainted } from "../../shared/taint.js";

/**
 * What an agent may ask of the catalog, and what it gets back.
 *
 * Search is a read: it costs nothing, so an agent may do it freely. Everything it returns
 * is merchant-authored text that an attacker may control — a marketplace seller, a
 * compromised admin, a supplier feed — so every string comes back branded Tainted<T> and
 * cannot reach a field a decision reads.
 */
export const CatalogSearchSchema = z.object({
  query: z.string().min(1).max(120).optional(),
  category: z.string().min(1).max(60).optional(),
  max_price_paise: PaiseSchema.optional(),
  min_price_paise: PaiseSchema.optional(),
  limit: z.number().int().positive().max(50).optional(),
});

export type CatalogSearchInput = z.infer<typeof CatalogSearchSchema>;

export interface CatalogItemView {
  /** Stable across a sync. This is what a quote request names. */
  readonly sku: string;
  readonly name: Tainted<string>;
  readonly category: Tainted<string>;
  readonly price_paise: string;
  /** Whether this item is inside the calling mandate's granted categories. */
  readonly in_scope: boolean;
}

export interface CatalogSearchResult {
  readonly items: readonly CatalogItemView[];
  readonly total: number;
  /** Categories this mandate may buy, so an agent can filter before it asks. */
  readonly allowed_categories: readonly string[];
}

export interface CatalogRow {
  sku: string;
  name: string;
  category: string;
  pricePaise: Paise;
}
