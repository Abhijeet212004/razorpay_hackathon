-- The quote records what it priced.
--
-- Until now a quote carried a basket_hash but not the basket, which is enough to prove an
-- intent matches a quote and not enough to reorder, show a receipt, or tell an agent what
-- it actually bought. The hash stays authoritative; this is the readable copy.
ALTER TABLE quotes ADD COLUMN basket JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN quotes.basket IS
  'Server-priced line items: [{sku, quantity, price_paise}]. Written by the quote service '
  'from the merchant catalog, never from the request.';
