-- Quotes, nonces, reservations, orders and webhook events.

-- The quote names the mandate it was issued to. Without that binding a signed quote is a
-- transferable credential for a price. consumed_at is the single-use enforcement, applied
-- inside the mandate lock.
CREATE TABLE quotes (
  quote_id     TEXT        PRIMARY KEY,
  mandate_id   TEXT        NOT NULL REFERENCES mandates (mandate_id),
  merchant_id  TEXT        NOT NULL,
  basket_hash  BYTEA       NOT NULL,
  amount_paise BIGINT      NOT NULL,
  -- Derived from the priced basket, never supplied by the agent. Category scope cannot
  -- be enforced without it: only the merchant's catalog knows what a basket touches.
  categories   TEXT[]      NOT NULL DEFAULT '{}',
  nonce        TEXT        NOT NULL UNIQUE,
  issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Quote TTL must outlive the step-up challenge TTL, or an approval arrives against an
  -- expired price.
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  consumed_by  TEXT,
  kid          TEXT        NOT NULL REFERENCES signing_keys (kid),
  signature    BYTEA       NOT NULL,

  CONSTRAINT quotes_amount_nonneg   CHECK (amount_paise >= 0),
  CONSTRAINT quotes_basket_hash_len CHECK (octet_length(basket_hash) = 32),
  CONSTRAINT quotes_expiry_order    CHECK (expires_at > issued_at),
  CONSTRAINT quotes_consumed_pair   CHECK ((consumed_at IS NULL) = (consumed_by IS NULL))
);

CREATE INDEX quotes_mandate_idx ON quotes (mandate_id, issued_at DESC);

-- The primary key is the burn. Burning is an INSERT; a replay raises a unique violation,
-- which denies. No read-then-write, so no race.
CREATE TABLE intent_nonces (
  nonce      TEXT        PRIMARY KEY,
  mandate_id TEXT        NOT NULL,
  intent_id  TEXT        NOT NULL,
  burned_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX intent_nonces_burned_idx ON intent_nonces (burned_at);

-- Authorised-but-unsettled amounts count against the cap, so two sequential intents
-- cannot each read a settled total that excludes the other.
CREATE TABLE reservations (
  reservation_id TEXT        PRIMARY KEY,
  mandate_id     TEXT        NOT NULL REFERENCES mandates (mandate_id),
  merchant_id    TEXT        NOT NULL,
  intent_id      TEXT        NOT NULL UNIQUE,
  amount_paise   BIGINT      NOT NULL,
  state          TEXT        NOT NULL,
  -- Set when the reservation was written for a step-up, whose TTL follows the challenge.
  step_up        BOOLEAN     NOT NULL DEFAULT false,
  release_reason TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at    TIMESTAMPTZ,

  CONSTRAINT reservations_amount_nonneg CHECK (amount_paise >= 0),
  CONSTRAINT reservations_state_known   CHECK (state IN ('held', 'captured', 'released')),
  CONSTRAINT reservations_resolved_pair CHECK ((state = 'held') = (resolved_at IS NULL)),
  CONSTRAINT reservations_reason_known  CHECK (release_reason IS NULL OR release_reason IN (
    'payment_failed', 'reaped', 'step_up_abandoned', 'unresolved', 'refunded'
  )),
  CONSTRAINT reservations_reason_only_when_released
    CHECK (release_reason IS NULL OR state = 'released')
);

-- INV-05: the cap read. Partial index over exactly the two counted states, so the sum
-- inside the lock is an index-only scan.
CREATE INDEX reservations_cap_idx ON reservations (mandate_id, created_at)
  WHERE state IN ('held', 'captured');

-- Supports the reaper, which only releases holds that never reached the executor.
CREATE INDEX reservations_held_idx ON reservations (created_at) WHERE state = 'held';

-- AUTHORISED -> SUBMITTED -> CAPTURED | FAILED, and SUBMITTED -> AMBIGUOUS on timeout.
-- There is deliberately no edge from AMBIGUOUS back to SUBMITTED: an ambiguous outcome
-- is resolved by reading provider state, never by retrying. Enforced in the reconciler,
-- since a CHECK cannot see the previous value.
CREATE TABLE orders (
  order_id        TEXT        PRIMARY KEY,
  intent_id       TEXT        NOT NULL UNIQUE,
  mandate_id      TEXT        NOT NULL REFERENCES mandates (mandate_id),
  merchant_id     TEXT        NOT NULL,
  amount_paise    BIGINT      NOT NULL,
  state           TEXT        NOT NULL,
  idempotency_key TEXT        NOT NULL,
  rzp_order_id    TEXT,
  rzp_payment_id  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT orders_amount_nonneg CHECK (amount_paise >= 0),
  CONSTRAINT orders_state_known   CHECK (state IN (
    'AUTHORISED', 'SUBMITTED', 'CAPTURED', 'FAILED', 'AMBIGUOUS', 'FAILED_UNRESOLVED'
  )),
  CONSTRAINT orders_idem_key_len  CHECK (char_length(idempotency_key) = 64)
);

CREATE INDEX orders_unresolved_idx ON orders (created_at)
  WHERE state IN ('SUBMITTED', 'AMBIGUOUS');

-- The primary key is the dedupe, taken inside the transition transaction, so a provider
-- event is applied at most once.
CREATE TABLE webhook_events (
  provider_event_id TEXT        PRIMARY KEY,
  merchant_id       TEXT        NOT NULL,
  event_type        TEXT        NOT NULL,
  payload_redacted  JSONB       NOT NULL,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
