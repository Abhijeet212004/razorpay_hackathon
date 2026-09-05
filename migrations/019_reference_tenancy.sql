-- Resolving a tenant from a reference rather than from a credential.
--
-- Every agent-facing route decides which merchant it is acting for by looking at an API
-- key. That is right for agents and wrong for everyone else, because the other callers on
-- this system are browsers:
--
--   a shopper granting a mandate at /consent/:ref
--   a shopper clearing a step up at /agent/approve/:challenge
--   a shopper paying at /pay/:intentId
--   an agent discovering a merchant it has no credential for
--
-- None of them hold a key. Today they fall back to MERCHANT_ID, so a hosted deployment,
-- which sets no default, answers 404 to every shopper. A single-tenant deployment works
-- only because there is exactly one merchant to guess.
--
-- The reference itself is the answer. A consent ref, a challenge id and an intent id are
-- all random UUIDs that belong to exactly one merchant, so knowing one is both the
-- identifier and the capability, the same way a receipt link works. Nothing here is
-- enumerable, and none of these functions leak anything but a merchant id.
--
-- SECURITY DEFINER with a pinned search_path, the same pattern as resolve_merchant_by_key,
-- because the caller has no tenant context for row level security to scope by. That is the
-- point: this is what establishes the context.

CREATE OR REPLACE FUNCTION resolve_merchant_by_consent_ref(p_ref TEXT)
RETURNS TABLE (merchant_id TEXT, state TEXT)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public STABLE
AS $$
  SELECT m.merchant_id, m.state
    FROM consent_requests c
    JOIN merchants m ON m.merchant_id = c.merchant_id
   WHERE c.request_ref = p_ref
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION resolve_merchant_by_challenge(p_challenge TEXT)
RETURNS TABLE (merchant_id TEXT, state TEXT)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public STABLE
AS $$
  SELECT m.merchant_id, m.state
    FROM challenges ch
    JOIN merchants m ON m.merchant_id = ch.merchant_id
   WHERE ch.challenge_id = p_challenge
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION resolve_merchant_by_order_intent(p_intent TEXT)
RETURNS TABLE (merchant_id TEXT, state TEXT)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public STABLE
AS $$
  SELECT m.merchant_id, m.state
    FROM orders o
    JOIN merchants m ON m.merchant_id = o.merchant_id
   WHERE o.intent_id = p_intent
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION resolve_merchant_by_mandate(p_mandate TEXT)
RETURNS TABLE (merchant_id TEXT, state TEXT)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public STABLE
AS $$
  SELECT m.merchant_id, m.state
    FROM mandates md
    JOIN merchants m ON m.merchant_id = md.merchant_id
   WHERE md.mandate_id = p_mandate
   LIMIT 1;
$$;

-- The key a merchant's authorisation handoffs are signed with.
--
-- It is the stored hash of their fulfil token: the merchant derives the same value by
-- hashing the token they hold, so both sides agree without the token ever being stored
-- reversibly. Read through a definer function because the caller is verifying a handoff
-- for a shopper who has no tenant context, and merchants is under forced row level
-- security. Returns the hash and nothing else.
CREATE OR REPLACE FUNCTION merchant_handoff_key(p_merchant_id TEXT)
RETURNS BYTEA
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public STABLE
AS $$
  SELECT m.fulfil_token_hash FROM merchants m WHERE m.merchant_id = p_merchant_id LIMIT 1;
$$;

-- Discovery. A merchant id is not a secret and is not a capability: this confirms that one
-- exists and is active, so the manifest can be served at a per-merchant path without a
-- credential. It returns nothing else.
CREATE OR REPLACE FUNCTION resolve_active_merchant(p_merchant_id TEXT)
RETURNS TABLE (merchant_id TEXT, state TEXT)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public STABLE
AS $$
  SELECT m.merchant_id, m.state
    FROM merchants m
   WHERE m.merchant_id = p_merchant_id
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION resolve_merchant_by_consent_ref(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_merchant_by_challenge(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_merchant_by_order_intent(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_merchant_by_mandate(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION merchant_handoff_key(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_active_merchant(TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION resolve_merchant_by_consent_ref(TEXT) TO agentkit_kernel;
GRANT EXECUTE ON FUNCTION resolve_merchant_by_challenge(TEXT) TO agentkit_kernel;
GRANT EXECUTE ON FUNCTION resolve_merchant_by_order_intent(TEXT) TO agentkit_kernel;
GRANT EXECUTE ON FUNCTION resolve_merchant_by_mandate(TEXT) TO agentkit_kernel;
GRANT EXECUTE ON FUNCTION merchant_handoff_key(TEXT) TO agentkit_kernel;
GRANT EXECUTE ON FUNCTION resolve_active_merchant(TEXT) TO agentkit_kernel;
