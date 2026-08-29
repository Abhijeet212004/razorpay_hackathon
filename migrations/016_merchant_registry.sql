-- Many merchants on one kernel.
--
-- Row level security has scoped every table by merchant_id since the first migration, so
-- the data layer was always multi-tenant. What was single-tenant was the request layer:
-- the merchant came from an environment variable, which works for one and cannot work for
-- two. These columns are what a merchant configures about themselves, so a second one
-- needs no redeploy.
--
-- The credential is the load-bearing part. An agent must never be able to name a merchant
-- — if it could, it would choose whose limits apply to it. The id is resolved from a
-- hashed key presented on the request and flows straight into the RLS context; nothing in
-- a request body is ever trusted to say who the merchant is.
ALTER TABLE merchants ADD COLUMN catalog_url     TEXT;
ALTER TABLE merchants ADD COLUMN fulfil_url      TEXT;
ALTER TABLE merchants ADD COLUMN authorize_url   TEXT;
ALTER TABLE merchants ADD COLUMN public_base_url TEXT;
ALTER TABLE merchants ADD COLUMN display_name    TEXT;

-- Never the key itself. A leaked table must not yield working credentials, so what is
-- stored is sha256(key) and a lookup is a hash comparison.
ALTER TABLE merchants ADD COLUMN api_key_hash    BYTEA;
ALTER TABLE merchants ADD COLUMN api_key_prefix  TEXT;
ALTER TABLE merchants ADD COLUMN fulfil_token_hash BYTEA;
ALTER TABLE merchants ADD COLUMN state           TEXT NOT NULL DEFAULT 'active';
ALTER TABLE merchants ADD COLUMN suspended_at    TIMESTAMPTZ;

ALTER TABLE merchants
  ADD CONSTRAINT merchants_state_known CHECK (state IN ('active', 'suspended'));
ALTER TABLE merchants
  ADD CONSTRAINT merchants_key_hash_len
  CHECK (api_key_hash IS NULL OR octet_length(api_key_hash) = 32);
ALTER TABLE merchants
  ADD CONSTRAINT merchants_fulfil_hash_len
  CHECK (fulfil_token_hash IS NULL OR octet_length(fulfil_token_hash) = 32);

-- Resolving a merchant happens on every agent request, so it is indexed. The prefix is
-- stored unhashed only so an operator can tell two keys apart in a console.
CREATE UNIQUE INDEX merchants_api_key_hash_idx ON merchants (api_key_hash)
  WHERE api_key_hash IS NOT NULL;

COMMENT ON COLUMN merchants.api_key_hash IS
  'sha256 of the merchant API key. The key is shown once at onboarding and never stored.';
COMMENT ON COLUMN merchants.state IS
  'suspended stops every agent call for this merchant without deleting their ledger.';

-- Resolving a merchant is the one lookup that cannot be tenant-scoped: it is what decides
-- the tenant. Rather than weaken the policy on merchants, it is a single SECURITY DEFINER
-- function that answers exactly one question and returns exactly one column.
--
-- search_path is pinned. A SECURITY DEFINER function that resolves names through the
-- caller's search_path can be made to call an attacker's function instead of pg_catalog's.
CREATE OR REPLACE FUNCTION resolve_merchant_by_key(key_hash BYTEA)
RETURNS TABLE (merchant_id TEXT, state TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
STABLE
AS $$
  SELECT m.merchant_id, m.state
    FROM merchants m
   WHERE m.api_key_hash = key_hash
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION resolve_merchant_by_key(BYTEA) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_merchant_by_key(BYTEA) TO agentkit_kernel;

-- The same for the merchant's own server-to-server calls, which present the fulfil token
-- rather than the agent-facing key. Separate credentials so leaking one does not grant
-- the other's reach.
CREATE OR REPLACE FUNCTION resolve_merchant_by_fulfil_token(token_hash BYTEA)
RETURNS TABLE (merchant_id TEXT, state TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
STABLE
AS $$
  SELECT m.merchant_id, m.state
    FROM merchants m
   WHERE m.fulfil_token_hash = token_hash
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION resolve_merchant_by_fulfil_token(BYTEA) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_merchant_by_fulfil_token(BYTEA) TO agentkit_kernel;

-- Onboarding writes these; nothing else does. The kernel may read its own row through RLS
-- once the context is set, but may not rewrite its own credentials or state.
GRANT UPDATE (catalog_url, fulfil_url, authorize_url, public_base_url, display_name)
  ON merchants TO agentkit_kernel;
