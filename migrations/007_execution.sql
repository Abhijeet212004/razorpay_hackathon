-- Step-up challenges, refunds, rate limiting, and operator aggregates.

-- A single-use challenge bound to one intent. Its TTL is shorter than the quote's, so an
-- approval can never arrive against a price that has already expired.
CREATE TABLE challenges (
  challenge_id TEXT        PRIMARY KEY,
  intent_id    TEXT        NOT NULL UNIQUE,
  mandate_id   TEXT        NOT NULL REFERENCES mandates (mandate_id),
  merchant_id  TEXT        NOT NULL,
  amount_paise BIGINT      NOT NULL,
  state        TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  resolved_at  TIMESTAMPTZ,

  CONSTRAINT challenges_state_known CHECK (state IN ('pending', 'approved', 'rejected', 'expired')),
  CONSTRAINT challenges_resolved_pair CHECK ((state = 'pending') = (resolved_at IS NULL))
);

CREATE INDEX challenges_pending_idx ON challenges (expires_at) WHERE state = 'pending';

-- Compensating entries for money that landed after revocation, or after a refund request.
CREATE TABLE refunds (
  refund_id       TEXT        PRIMARY KEY,
  order_id        TEXT        NOT NULL REFERENCES orders (order_id),
  merchant_id     TEXT        NOT NULL,
  amount_paise    BIGINT      NOT NULL,
  reason          TEXT        NOT NULL,
  state           TEXT        NOT NULL,
  rzp_refund_id   TEXT,
  idempotency_key TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT refunds_amount_nonneg CHECK (amount_paise >= 0),
  CONSTRAINT refunds_state_known   CHECK (state IN ('REQUESTED', 'SUBMITTED', 'COMPLETED', 'FAILED'))
);

CREATE INDEX refunds_order_idx ON refunds (order_id);

-- Request rate, at the edge only. Postgres-backed so the bucket survives more than one
-- kernel instance; spend velocity is a different control and lives inside the lock.
CREATE TABLE rate_limit_buckets (
  bucket_key  TEXT        PRIMARY KEY,
  merchant_id TEXT        NOT NULL,
  tokens      NUMERIC     NOT NULL,
  refilled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-merchant aggregates for the operator console. Counts and sums only: no intent id,
-- no mandate id, no pseudonym, no amount attributable to one transaction. The operator
-- console reads this table and nothing else, so cross-merchant reads never touch the
-- ledger and row level security holds for every read.
CREATE TABLE operator_metrics (
  merchant_id       TEXT        NOT NULL,
  window_start      TIMESTAMPTZ NOT NULL,
  decisions_total   BIGINT      NOT NULL,
  denials_total     BIGINT      NOT NULL,
  denials_by_code   JSONB       NOT NULL,
  gmv_paise         BIGINT      NOT NULL,
  active_mandates   INT         NOT NULL,
  reservations_held BIGINT      NOT NULL,
  chain_status      TEXT        NOT NULL,
  breaker_trips     INT         NOT NULL,
  refreshed_at      TIMESTAMPTZ NOT NULL,

  CONSTRAINT operator_metrics_pk PRIMARY KEY (merchant_id, window_start),
  CONSTRAINT operator_metrics_chain_status CHECK (chain_status IN ('ok', 'broken'))
);

ALTER TABLE challenges         ENABLE ROW LEVEL SECURITY;
ALTER TABLE challenges         FORCE  ROW LEVEL SECURITY;
CREATE POLICY challenges_tenant ON challenges
  USING      (merchant_id = current_setting('agentkit.merchant_id', true))
  WITH CHECK (merchant_id = current_setting('agentkit.merchant_id', true));

ALTER TABLE refunds            ENABLE ROW LEVEL SECURITY;
ALTER TABLE refunds            FORCE  ROW LEVEL SECURITY;
CREATE POLICY refunds_tenant ON refunds
  USING      (merchant_id = current_setting('agentkit.merchant_id', true))
  WITH CHECK (merchant_id = current_setting('agentkit.merchant_id', true));

ALTER TABLE rate_limit_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_buckets FORCE  ROW LEVEL SECURITY;
CREATE POLICY rate_limit_buckets_tenant ON rate_limit_buckets
  USING      (merchant_id = current_setting('agentkit.merchant_id', true))
  WITH CHECK (merchant_id = current_setting('agentkit.merchant_id', true));

-- operator_metrics is deliberately outside row level security: it is the one table read
-- across merchants, which is safe precisely because it holds no identifiers.

ALTER TABLE challenges         OWNER TO agentkit_owner;
ALTER TABLE refunds            OWNER TO agentkit_owner;
ALTER TABLE rate_limit_buckets OWNER TO agentkit_owner;
ALTER TABLE operator_metrics   OWNER TO agentkit_owner;

GRANT SELECT, INSERT ON challenges TO agentkit_kernel;
GRANT UPDATE (state, resolved_at) ON challenges TO agentkit_kernel;
GRANT SELECT, INSERT ON refunds TO agentkit_kernel;
GRANT UPDATE (state, rzp_refund_id, updated_at) ON refunds TO agentkit_kernel;
GRANT SELECT, INSERT ON rate_limit_buckets TO agentkit_kernel;
GRANT UPDATE (tokens, refilled_at) ON rate_limit_buckets TO agentkit_kernel;

GRANT SELECT ON challenges TO agentkit_worker;
GRANT UPDATE (state, resolved_at) ON challenges TO agentkit_worker;
GRANT SELECT, INSERT ON refunds TO agentkit_worker;
GRANT UPDATE (state, rzp_refund_id, updated_at) ON refunds TO agentkit_worker;
GRANT SELECT, INSERT ON operator_metrics TO agentkit_worker;
GRANT UPDATE ON operator_metrics TO agentkit_worker;

GRANT SELECT ON challenges       TO agentkit_console;
GRANT SELECT ON refunds          TO agentkit_console;
GRANT SELECT ON operator_metrics TO agentkit_console;
