-- The payment instrument a mandate may be charged against.
--
-- A Razorpay customer id and a token id, both opaque. The token is what the shopper's own
-- bank authorised, with its own ceiling recorded there; ours is narrower and is the one
-- that can be revoked without them opening a banking app.
--
-- Note what is absent: no card number, no VPA, no bank name, nothing that identifies an
-- instrument to a human reading this table. A token is useless anywhere except charging
-- within the ceiling the bank already agreed to, which is why it is safe to store beside
-- the policy that constrains it.
--
-- An agent never supplies these and never reads them. They are written once, by the
-- consent flow, after the shopper has approved the mandate in their own banking app.
ALTER TABLE mandates ADD COLUMN payment_customer_ref TEXT;
ALTER TABLE mandates ADD COLUMN payment_token_ref    TEXT;
ALTER TABLE mandates ADD COLUMN payment_max_paise    BIGINT;

COMMENT ON COLUMN mandates.payment_customer_ref IS
  'Razorpay customer id. Opaque; the rail''s handle for this shopper.';
COMMENT ON COLUMN mandates.payment_token_ref IS
  'Razorpay token id for the instrument the shopper authorised. Charging it is only '
  'possible within the ceiling their bank recorded.';
COMMENT ON COLUMN mandates.payment_max_paise IS
  'The ceiling the bank recorded, kept so the console can show both limits side by side. '
  'Never enforced here — the bank enforces it, and our own limits are narrower.';

-- Consent carries them from the moment the shopper authorises until the mandate is issued.
ALTER TABLE consent_requests ADD COLUMN payment_customer_ref TEXT;
ALTER TABLE consent_requests ADD COLUMN payment_token_ref    TEXT;
ALTER TABLE consent_requests ADD COLUMN payment_max_paise    BIGINT;

GRANT UPDATE (payment_customer_ref, payment_token_ref, payment_max_paise)
  ON consent_requests TO agentkit_kernel;

-- The kernel writes these during consent and never again. The grant is per-column, like
-- every other write it has: an UPDATE it does not need is an UPDATE it cannot make.
GRANT UPDATE (payment_customer_ref, payment_token_ref, payment_max_paise)
  ON mandates TO agentkit_kernel;

-- The worker gets no write here at all. Attaching an instrument is a decision a shopper
-- makes in front of their bank; no background job has any business doing it.
