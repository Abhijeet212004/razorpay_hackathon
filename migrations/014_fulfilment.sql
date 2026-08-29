-- Who the shopper is, and where their order goes.
--
-- The agent supplies neither. An agent that could set the delivery address could redirect
-- the goods, which is the same shape of problem as an agent that could name a payee — and
-- the same answer applies: there is no field for it.
--
-- Both of these are opaque references into the merchant's own systems. We store the
-- merchant's id for their customer and their id for a saved address, and never the
-- address itself. There is nothing here to leak and nothing extra to erase: pseudonym_map
-- remains the single erasure target.
ALTER TABLE mandates ADD COLUMN customer_ref   TEXT;
ALTER TABLE mandates ADD COLUMN fulfilment_ref TEXT;

COMMENT ON COLUMN mandates.customer_ref IS
  'The merchant''s own id for this shopper. Captured at consent, when the merchant knows '
  'who is logged in. Never supplied by an agent.';
COMMENT ON COLUMN mandates.fulfilment_ref IS
  'The merchant''s own id for the delivery address the shopper chose at consent. An id, '
  'never an address.';

ALTER TABLE consent_requests ADD COLUMN customer_ref   TEXT;
ALTER TABLE consent_requests ADD COLUMN fulfilment_ref TEXT;

GRANT UPDATE (customer_ref, fulfilment_ref) ON consent_requests TO agentkit_kernel;
