-- The append-only, hash-chained ledger.
--
-- One chain per mandate: chain_id = mandate_id. A single global chain forks whenever two
-- concurrent appends read the same tail. Per-mandate chains inherit the mandate row lock
-- that the cap check already holds, so serialisation costs nothing.

CREATE TABLE ledger (
  chain_id         TEXT        NOT NULL,
  seq              BIGINT      NOT NULL,
  prev_hash        BYTEA       NOT NULL,
  hash             BYTEA       NOT NULL,
  kind             TEXT        NOT NULL,
  merchant_id      TEXT        NOT NULL,
  ref              TEXT,
  payload_redacted JSONB       NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ledger_pk PRIMARY KEY (chain_id, seq),

  -- Makes a fork unwritable. Two entries claiming the same predecessor collide at the
  -- storage layer rather than in application code. Genesis carries 32 zero bytes, so
  -- this also prevents a second genesis entry on a live chain.
  CONSTRAINT ledger_no_fork UNIQUE (chain_id, prev_hash),

  CONSTRAINT ledger_prev_hash_len CHECK (octet_length(prev_hash) = 32),
  CONSTRAINT ledger_hash_len      CHECK (octet_length(hash) = 32),
  CONSTRAINT ledger_seq_nonneg    CHECK (seq >= 0),
  CONSTRAINT ledger_kind_known    CHECK (kind IN (
    'MANDATE_ISSUED', 'INTENT', 'DECISION', 'RESERVATION', 'API_CALL', 'WEBHOOK',
    'EXECUTION_RESULT', 'RELEASE', 'RECONCILE', 'REFUND', 'ANCHOR'
  ))
);

CREATE INDEX ledger_chain_seq_idx ON ledger (chain_id, seq DESC);
CREATE INDEX ledger_merchant_idx  ON ledger (merchant_id, created_at DESC);
CREATE INDEX ledger_kind_idx      ON ledger (kind, created_at DESC);
CREATE INDEX ledger_ref_idx       ON ledger (ref) WHERE ref IS NOT NULL;

-- Periodic checkpoint of every live chain head, signed with a dedicated anchor key so
-- the checkpoint is independently attributable.
CREATE TABLE ledger_anchor (
  anchor_id   TEXT        PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  chain_heads JSONB       NOT NULL,
  kid         TEXT        NOT NULL,
  sig         BYTEA       NOT NULL
);

CREATE INDEX ledger_anchor_created_idx ON ledger_anchor (created_at DESC);

-- INV-11: the ledger is append-only from every application role. The grants file never
-- hands back UPDATE or DELETE; these statements state the intent so removing the
-- protection is a visible edit rather than an omission.
REVOKE UPDATE, DELETE, TRUNCATE ON ledger        FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON ledger_anchor FROM PUBLIC;
