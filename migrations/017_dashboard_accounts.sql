-- People who sign in to the dashboard, as distinct from merchants.
--
-- A merchant is an organisation with credentials and a ledger. A dashboard account is a
-- person who can see and configure one. Keeping them separate means a merchant can
-- outlive the person who created it, and a person can be removed without touching the
-- merchant's data.
--
-- Sessions are stored server-side rather than signed into a cookie: a dashboard can show
-- and rotate live API keys, so being able to revoke a session immediately matters more
-- than saving a database read.
CREATE TABLE dashboard_users (
  user_id       TEXT        PRIMARY KEY,
  email         TEXT        NOT NULL,
  merchant_id   TEXT        NOT NULL REFERENCES merchants (merchant_id),
  password_hash TEXT        NOT NULL,
  display_name  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ,

  CONSTRAINT dashboard_users_email_shape CHECK (email LIKE '%@%')
);

-- One account per address. Case is folded on the way in so two capitalisations of the
-- same address cannot become two accounts.
CREATE UNIQUE INDEX dashboard_users_email_idx ON dashboard_users (lower(email));

CREATE TABLE dashboard_sessions (
  session_id  TEXT        PRIMARY KEY,
  user_id     TEXT        NOT NULL REFERENCES dashboard_users (user_id) ON DELETE CASCADE,
  merchant_id TEXT        NOT NULL REFERENCES merchants (merchant_id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ
);

CREATE INDEX dashboard_sessions_user_idx ON dashboard_sessions (user_id, expires_at DESC);

-- These two tables are the one place a person is named, and they sit outside the tenant
-- policies on purpose: resolving a session is what establishes the tenant, so it cannot
-- already be scoped by one. They carry no shopper data — only whoever operates the shop.
ALTER TABLE dashboard_users    OWNER TO agentkit_owner;
ALTER TABLE dashboard_sessions OWNER TO agentkit_owner;

GRANT SELECT, INSERT, UPDATE (last_seen_at) ON dashboard_users    TO agentkit_kernel;
GRANT SELECT, INSERT, UPDATE (revoked_at)   ON dashboard_sessions TO agentkit_kernel;

-- Rotating a key is a dashboard action, so the kernel needs to write the new hash.
GRANT UPDATE (api_key_hash, api_key_prefix, fulfil_token_hash) ON merchants TO agentkit_kernel;
