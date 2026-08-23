-- SUBMITTING: the order row exists before the outbound call, not after it.
--
-- Written and committed before the executor touches the rail, so the absence of an order
-- row carries a stronger claim than it did:
--
--   no order row   we are certain no call was made        the reaper may release the hold
--   SUBMITTING     a call may have been made, unknown     the reconciler owns it
--   SUBMITTED      a call was made and was accepted       the reconciler owns it
--   AMBIGUOUS      a call was made, outcome unknown       the reconciler owns it
--
-- Previously "no order row" meant "no call succeeded", which is a different claim. A
-- timeout left no row and possibly a real payment, and the reaper would then release a
-- hold for money that had moved.

ALTER TABLE orders DROP CONSTRAINT orders_state_known;

ALTER TABLE orders ADD CONSTRAINT orders_state_known CHECK (state IN (
  'AUTHORISED', 'SUBMITTING', 'SUBMITTED', 'CAPTURED', 'FAILED', 'AMBIGUOUS',
  'FAILED_UNRESOLVED'
));

-- A process that dies mid-call leaves a row here forever, so the reconciler sweeps them.
DROP INDEX orders_unresolved_idx;
CREATE INDEX orders_unresolved_idx ON orders (created_at)
  WHERE state IN ('SUBMITTING', 'SUBMITTED', 'AMBIGUOUS');
