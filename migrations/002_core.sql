-- Identity, signing keys and mandates.
--
-- agents and auth_events carry no merchant column and stay outside row level security.

CREATE TABLE agents (
  agent_id    TEXT        PRIMARY KEY,
  name        TEXT        NOT NULL,
  public_key  BYTEA       NOT NULL,
  attestation TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT agents_pubkey_len CHECK (octet_length(public_key) = 32)
);

-- max_age_seconds is the freshness bound applied when granting, widening or stepping up.
-- There is no age check at authorisation time: the mandate's own not_after is that
-- bound, and re-checking auth age would expire every mandate within minutes.
CREATE TABLE auth_events (
  auth_event_id     TEXT        PRIMARY KEY,
  subject_pseudonym TEXT        NOT NULL,
  method            TEXT        NOT NULL,
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  max_age_seconds   INTEGER     NOT NULL,

  CONSTRAINT auth_events_method_known CHECK (method IN ('sms_otp', 'upi_pin')),
  CONSTRAINT auth_events_max_age_pos  CHECK (max_age_seconds > 0)
);

CREATE INDEX auth_events_subject_idx ON auth_events (subject_pseudonym, occurred_at DESC);

CREATE TABLE signing_keys (
  kid         TEXT        PRIMARY KEY,
  purpose     TEXT        NOT NULL,
  state       TEXT        NOT NULL,
  public_key  BYTEA       NOT NULL,
  private_key BYTEA,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at  TIMESTAMPTZ,

  CONSTRAINT signing_keys_purpose_known CHECK (purpose IN ('mandate', 'quote', 'catalog', 'anchor')),
  CONSTRAINT signing_keys_state_known   CHECK (state IN ('active', 'retired')),
  CONSTRAINT signing_keys_pubkey_len    CHECK (octet_length(public_key) = 32),
  CONSTRAINT signing_keys_retired_at    CHECK ((state = 'retired') = (retired_at IS NOT NULL))
);

-- One active key per purpose. Partial, so retired keys accumulate freely and only the
-- active slot is contended. Verification accepts retired keys; issuance uses the active.
CREATE UNIQUE INDEX signing_keys_one_active_per_purpose
  ON signing_keys (purpose) WHERE state = 'active';

-- The only mutable identity store, and the target of an erasure request. Deleting a row
-- here leaves every chain that referenced the pseudonym still verifiable.
CREATE TABLE pseudonym_map (
  subject_pseudonym TEXT        PRIMARY KEY,
  person_ref        TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The row lock target. Every authoriser for a mandate serialises on this row, and the
-- mandate's hash chain inherits the same lock.
CREATE TABLE mandates (
  mandate_id             TEXT        PRIMARY KEY,
  merchant_id            TEXT        NOT NULL,
  subject_pseudonym      TEXT        NOT NULL,
  agent_id               TEXT        NOT NULL REFERENCES agents (agent_id),
  auth_event_id          TEXT        NOT NULL REFERENCES auth_events (auth_event_id),

  -- Money limits are BIGINT columns rather than JSONB, so no amount round-trips
  -- through a JSON number.
  per_transaction_paise  BIGINT      NOT NULL,
  cumulative_paise       BIGINT      NOT NULL,
  cumulative_window      INTERVAL    NOT NULL,
  velocity_per_hour      INTEGER     NOT NULL,
  silent_threshold_paise BIGINT      NOT NULL,

  scope                  JSONB       NOT NULL,
  state                  TEXT        NOT NULL,
  not_before             TIMESTAMPTZ NOT NULL,
  not_after              TIMESTAMPTZ NOT NULL,
  revoked_at             TIMESTAMPTZ,

  chain_id               TEXT        NOT NULL,
  chain_head_seq         BIGINT,
  chain_head_hash        BYTEA,

  kid                    TEXT        NOT NULL REFERENCES signing_keys (kid),
  signature              BYTEA       NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The chain id is the mandate id. Stated as a constraint so a later edit cannot
  -- quietly reintroduce a single global chain.
  CONSTRAINT mandates_chain_is_self   CHECK (chain_id = mandate_id),
  CONSTRAINT mandates_state_known     CHECK (state IN ('live', 'revoked', 'expired')),
  CONSTRAINT mandates_revoked_at      CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
  CONSTRAINT mandates_validity_order  CHECK (not_after > not_before),
  CONSTRAINT mandates_limits_nonneg   CHECK (
    per_transaction_paise  >= 0 AND
    cumulative_paise       >= 0 AND
    silent_threshold_paise >= 0 AND
    velocity_per_hour      >= 0
  ),
  CONSTRAINT mandates_chain_head_pair CHECK ((chain_head_seq IS NULL) = (chain_head_hash IS NULL)),
  CONSTRAINT mandates_chain_head_len  CHECK (chain_head_hash IS NULL OR octet_length(chain_head_hash) = 32)
);

CREATE INDEX mandates_merchant_idx ON mandates (merchant_id, state);
CREATE INDEX mandates_subject_idx  ON mandates (subject_pseudonym, state);
CREATE INDEX mandates_expiry_idx   ON mandates (not_after) WHERE state = 'live';
