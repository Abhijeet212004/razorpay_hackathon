-- Merchants and their catalog.

-- The lock target for the operations chain, which carries every decision that has no
-- mandate chain to live on. Appends to chain_id = merchant_id serialise here, exactly as
-- appends to a mandate's chain serialise on the mandate row.
CREATE TABLE merchants (
  merchant_id     TEXT        PRIMARY KEY,
  name            TEXT        NOT NULL,
  chain_head_seq  BIGINT,
  chain_head_hash BYTEA,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT merchants_chain_head_pair CHECK ((chain_head_seq IS NULL) = (chain_head_hash IS NULL)),
  CONSTRAINT merchants_chain_head_len  CHECK (chain_head_hash IS NULL OR octet_length(chain_head_hash) = 32)
);

-- Prices come from the merchant's own catalog, never from the agent. The category of a
-- basket is derived here too: only the merchant knows what it is selling.
CREATE TABLE catalog_items (
  merchant_id  TEXT        NOT NULL REFERENCES merchants (merchant_id),
  sku          TEXT        NOT NULL,
  name         TEXT        NOT NULL,
  category     TEXT        NOT NULL,
  price_paise  BIGINT      NOT NULL,
  active       BOOLEAN     NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT catalog_items_pk    PRIMARY KEY (merchant_id, sku),
  CONSTRAINT catalog_price_nonneg CHECK (price_paise >= 0)
);

CREATE INDEX catalog_items_category_idx ON catalog_items (merchant_id, category) WHERE active;

ALTER TABLE merchants     ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchants     FORCE  ROW LEVEL SECURITY;
CREATE POLICY merchants_tenant ON merchants
  USING      (merchant_id = current_setting('agentkit.merchant_id', true))
  WITH CHECK (merchant_id = current_setting('agentkit.merchant_id', true));

ALTER TABLE catalog_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_items FORCE  ROW LEVEL SECURITY;
CREATE POLICY catalog_items_tenant ON catalog_items
  USING      (merchant_id = current_setting('agentkit.merchant_id', true))
  WITH CHECK (merchant_id = current_setting('agentkit.merchant_id', true));

ALTER TABLE merchants     OWNER TO agentkit_owner;
ALTER TABLE catalog_items OWNER TO agentkit_owner;

GRANT SELECT, INSERT ON merchants     TO agentkit_kernel;
GRANT UPDATE (chain_head_seq, chain_head_hash) ON merchants TO agentkit_kernel;
GRANT SELECT, INSERT ON catalog_items TO agentkit_kernel;

GRANT SELECT ON merchants     TO agentkit_worker;
GRANT SELECT ON catalog_items TO agentkit_worker;

GRANT SELECT ON merchants     TO agentkit_console;
GRANT SELECT ON catalog_items TO agentkit_console;
