-- MCP sessions.
--
-- An MCP client such as Claude Desktop cannot hold an Ed25519 key or canonicalise a
-- payload, so it cannot sign an intent itself. A session gives it an identity the kernel
-- can sign on behalf of.
--
-- That is a real weakening and it is recorded as one: a session token is bearer
-- authentication, which is revocable but not non-repudiable, where a signature is the
-- reverse. Every decision made under a session records which mechanism authenticated it,
-- so an auditor can tell the two apart.
--
-- What it is NOT is a weakening of authority. A session identifies an agent; it grants
-- nothing. Every purchase still needs a mandate a human granted, and still faces every
-- check under the mandate row lock. A stolen session token buys exactly what a stolen
-- agent private key buys: one mandate's worth, bounded, logged and revocable.
CREATE TABLE mcp_sessions (
  session_id   TEXT        PRIMARY KEY,
  merchant_id  TEXT        NOT NULL,
  agent_id     TEXT        NOT NULL REFERENCES agents (agent_id),
  client_name  TEXT        NOT NULL,
  -- The session's own signing key. Scoped to this session and useless without a mandate.
  private_key  BYTEA       NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,

  CONSTRAINT mcp_sessions_expiry CHECK (expires_at > created_at)
);

CREATE INDEX mcp_sessions_agent_idx ON mcp_sessions (agent_id);
CREATE INDEX mcp_sessions_live_idx  ON mcp_sessions (expires_at) WHERE revoked_at IS NULL;

ALTER TABLE mcp_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_sessions FORCE  ROW LEVEL SECURITY;
CREATE POLICY mcp_sessions_tenant ON mcp_sessions
  USING      (merchant_id = current_setting('agentkit.merchant_id', true))
  WITH CHECK (merchant_id = current_setting('agentkit.merchant_id', true));

ALTER TABLE mcp_sessions OWNER TO agentkit_owner;

GRANT SELECT, INSERT ON mcp_sessions TO agentkit_kernel;
GRANT UPDATE (last_seen_at, revoked_at) ON mcp_sessions TO agentkit_kernel;
-- Deliberately absent from the console: it holds session key material.
GRANT SELECT (session_id, merchant_id, agent_id, client_name, created_at, last_seen_at,
              expires_at, revoked_at)
  ON mcp_sessions TO agentkit_worker;
