import { z } from "zod";
import { PaiseSchema, paiseToCanonical } from "../../shared/money.js";
import type { JsonValue } from "../../shared/crypto/jcs.js";

/**
 * A quote is priced server-side and names the mandate it was issued to. Without that
 * binding a signed quote is a transferable credential for a price — obtainable under a
 * permissive mandate and spendable under a restrictive one.
 */
export const QuoteSchema = z.object({
  quote_id: z.string().min(1),
  mandate_id: z.string().min(1),
  merchant_id: z.string().min(1),
  basket_hash: z.string().regex(/^[0-9a-f]{64}$/),
  amount_paise: PaiseSchema,
  /** Derived from the priced basket, never supplied by the agent. Checked against scope. */
  categories: z.array(z.string().min(1)),
  nonce: z.string().min(16).max(128),
  issued_at: z.string().datetime({ offset: true }),
  expires_at: z.string().datetime({ offset: true }),
});

export type Quote = z.infer<typeof QuoteSchema>;

export const SignedQuoteSchema = z.object({
  quote: QuoteSchema,
  kid: z.string().min(1),
  signature: z.string().regex(/^[0-9a-f]+$/),
});

export type SignedQuote = z.infer<typeof SignedQuoteSchema>;

/** The exact bytes signed and verified. Both sides import this. */
export function quoteSigningPayload(quote: Quote): JsonValue {
  return {
    amount_paise: paiseToCanonical(quote.amount_paise),
    basket_hash: quote.basket_hash,
    categories: [...quote.categories].sort(),
    expires_at: quote.expires_at,
    issued_at: quote.issued_at,
    mandate_id: quote.mandate_id,
    merchant_id: quote.merchant_id,
    nonce: quote.nonce,
    quote_id: quote.quote_id,
  };
}
