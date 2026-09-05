-- The public record of one decision.
--
-- Every decision the kernel returns carries an audit_url, and until now nothing served
-- it: the link was generated in three places and 404'd everywhere. This is the read
-- behind it.
--
-- It has to cross tenants, because the reader is not authenticated. A shopper checking
-- what their assistant did, or a merchant's support desk, has no API key and no session,
-- and the intent id is the only thing they hold. That is deliberate: the id is a random
-- UUID, so knowing it is the capability, in the same way a receipt link works. Nothing
-- here is enumerable and nothing here is guessable.
--
-- SECURITY DEFINER with a pinned search_path, the same pattern as the tenant resolvers,
-- because the ledger is under forced row level security and the caller has no context set.

CREATE OR REPLACE FUNCTION audit_by_intent(p_intent_id TEXT)
RETURNS TABLE (
  kind TEXT,
  seq BIGINT,
  hash BYTEA,
  prev_hash BYTEA,
  payload JSONB,
  created_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
STABLE
AS $$
  SELECT l.kind,
         l.seq,
         l.hash,
         l.prev_hash,
         -- payload_redacted is what the writer chose to keep. The nested "payload" is the
         -- event itself; the envelope around it repeats ids the caller already has.
         l.payload_redacted -> 'payload',
         l.created_at
    FROM ledger l
   WHERE l.ref = p_intent_id
   ORDER BY l.seq;
$$;

REVOKE ALL ON FUNCTION audit_by_intent(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_by_intent(TEXT) TO agentkit_kernel;
