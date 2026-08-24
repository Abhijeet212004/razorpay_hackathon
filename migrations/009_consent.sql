-- Consent requests, and the OTP that turns one into a mandate.
--
-- A grant is the only time the user touches merchant property, so the state it runs on is
-- server-held: the scope shown on screen is read from here, never from anything the agent
-- supplied.

CREATE TABLE consent_requests (
  request_ref     TEXT        PRIMARY KEY,
  merchant_id     TEXT        NOT NULL,
  agent_id        TEXT        NOT NULL REFERENCES agents (agent_id),
  requested_scope JSONB       NOT NULL,
  contact         TEXT        NOT NULL,
  state           TEXT        NOT NULL,
  otp_hash        BYTEA,
  otp_expires_at  TIMESTAMPTZ,
  otp_attempts    INT         NOT NULL DEFAULT 0,
  mandate_id      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,

  CONSTRAINT consent_state_known CHECK (state IN ('pending', 'otp_sent', 'granted', 'rejected', 'expired')),
  -- Five wrong codes and the request is dead. An OTP with unlimited attempts is a
  -- four-digit password.
  CONSTRAINT consent_attempts_bounded CHECK (otp_attempts <= 5)
);

CREATE INDEX consent_requests_state_idx ON consent_requests (state, created_at);

ALTER TABLE consent_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_requests FORCE  ROW LEVEL SECURITY;
CREATE POLICY consent_requests_tenant ON consent_requests
  USING      (merchant_id = current_setting('agentkit.merchant_id', true))
  WITH CHECK (merchant_id = current_setting('agentkit.merchant_id', true));

ALTER TABLE consent_requests OWNER TO agentkit_owner;

GRANT SELECT, INSERT ON consent_requests TO agentkit_kernel;
GRANT UPDATE (state, otp_hash, otp_expires_at, otp_attempts, mandate_id, resolved_at)
  ON consent_requests TO agentkit_kernel;
GRANT SELECT ON consent_requests TO agentkit_console;
GRANT SELECT ON consent_requests TO agentkit_worker;
GRANT UPDATE (state, resolved_at) ON consent_requests TO agentkit_worker;
