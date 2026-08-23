-- INV-21: merchant isolation is enforced by PostgreSQL, not by application code.
--
-- FORCE applies the policy to the table owner too. Without it, any path running as the
-- owner reads across merchants while service-role queries stay correctly scoped.
--
-- The predicate uses current_setting(..., true), whose second argument means a missing
-- setting yields NULL rather than raising. NULL matches no rows, so a caller that
-- forgets to set the context sees an empty database rather than everything.
--
-- Set per request in the kernel and console, and per job from the job payload in the
-- worker, with: SELECT set_config('agentkit.merchant_id', $1, true)
--
-- agents, auth_events, signing_keys, intent_nonces, pseudonym_map and ledger_anchor
-- carry no merchant column and are out of scope.

ALTER TABLE ledger         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger         FORCE  ROW LEVEL SECURITY;
CREATE POLICY ledger_tenant ON ledger
  USING      (merchant_id = current_setting('agentkit.merchant_id', true))
  WITH CHECK (merchant_id = current_setting('agentkit.merchant_id', true));

ALTER TABLE mandates       ENABLE ROW LEVEL SECURITY;
ALTER TABLE mandates       FORCE  ROW LEVEL SECURITY;
CREATE POLICY mandates_tenant ON mandates
  USING      (merchant_id = current_setting('agentkit.merchant_id', true))
  WITH CHECK (merchant_id = current_setting('agentkit.merchant_id', true));

ALTER TABLE reservations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservations   FORCE  ROW LEVEL SECURITY;
CREATE POLICY reservations_tenant ON reservations
  USING      (merchant_id = current_setting('agentkit.merchant_id', true))
  WITH CHECK (merchant_id = current_setting('agentkit.merchant_id', true));

ALTER TABLE quotes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotes         FORCE  ROW LEVEL SECURITY;
CREATE POLICY quotes_tenant ON quotes
  USING      (merchant_id = current_setting('agentkit.merchant_id', true))
  WITH CHECK (merchant_id = current_setting('agentkit.merchant_id', true));

ALTER TABLE orders         ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders         FORCE  ROW LEVEL SECURITY;
CREATE POLICY orders_tenant ON orders
  USING      (merchant_id = current_setting('agentkit.merchant_id', true))
  WITH CHECK (merchant_id = current_setting('agentkit.merchant_id', true));

ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events FORCE  ROW LEVEL SECURITY;
CREATE POLICY webhook_events_tenant ON webhook_events
  USING      (merchant_id = current_setting('agentkit.merchant_id', true))
  WITH CHECK (merchant_id = current_setting('agentkit.merchant_id', true));
