-- The grant matrix, stated table by table.
--
-- Nothing below hands UPDATE or DELETE on ledger or ledger_anchor to any role. UPDATE
-- grants are column-level wherever only specific columns are needed: a table-level UPDATE
-- would let the kernel rewrite the caps it is about to be checked against.

-- Every table is owned by a non-superuser with NOBYPASSRLS, so FORCE row level security
-- has a principal it actually constrains.
ALTER TABLE ledger         OWNER TO agentkit_owner;
ALTER TABLE ledger_anchor  OWNER TO agentkit_owner;
ALTER TABLE agents         OWNER TO agentkit_owner;
ALTER TABLE auth_events    OWNER TO agentkit_owner;
ALTER TABLE signing_keys   OWNER TO agentkit_owner;
ALTER TABLE pseudonym_map  OWNER TO agentkit_owner;
ALTER TABLE mandates       OWNER TO agentkit_owner;
ALTER TABLE quotes         OWNER TO agentkit_owner;
ALTER TABLE intent_nonces  OWNER TO agentkit_owner;
ALTER TABLE reservations   OWNER TO agentkit_owner;
ALTER TABLE orders         OWNER TO agentkit_owner;
ALTER TABLE webhook_events OWNER TO agentkit_owner;


-- Kernel and executor services.
GRANT SELECT, INSERT ON ledger         TO agentkit_kernel;
GRANT SELECT, INSERT ON reservations   TO agentkit_kernel;
GRANT SELECT, INSERT ON quotes         TO agentkit_kernel;
GRANT SELECT, INSERT ON orders         TO agentkit_kernel;
GRANT SELECT, INSERT ON intent_nonces  TO agentkit_kernel;
GRANT SELECT, INSERT ON auth_events    TO agentkit_kernel;
GRANT SELECT, INSERT ON webhook_events TO agentkit_kernel;
GRANT SELECT, INSERT ON mandates       TO agentkit_kernel;
GRANT SELECT, INSERT ON agents         TO agentkit_kernel;

GRANT UPDATE (state, revoked_at, chain_head_seq, chain_head_hash) ON mandates     TO agentkit_kernel;
GRANT UPDATE (state, resolved_at, release_reason)                 ON reservations TO agentkit_kernel;
GRANT UPDATE (consumed_at, consumed_by)                           ON quotes       TO agentkit_kernel;
GRANT UPDATE (state, rzp_order_id, rzp_payment_id, updated_at)    ON orders       TO agentkit_kernel;

GRANT SELECT ON signing_keys TO agentkit_kernel;

-- Consent runs inside the kernel, and granting a mandate creates the subject pseudonym.
-- No UPDATE and no DELETE: erasure belongs to the admin role alone.
GRANT SELECT, INSERT ON pseudonym_map TO agentkit_kernel;


-- Background jobs. Resolves; never authorises.
GRANT SELECT ON mandates     TO agentkit_worker;
GRANT SELECT ON orders       TO agentkit_worker;
GRANT SELECT ON reservations TO agentkit_worker;
GRANT SELECT ON quotes       TO agentkit_worker;

GRANT SELECT, INSERT ON ledger        TO agentkit_worker;
GRANT SELECT, INSERT ON ledger_anchor TO agentkit_worker;

GRANT UPDATE (state, resolved_at, release_reason)              ON reservations TO agentkit_worker;
GRANT UPDATE (state, rzp_order_id, rzp_payment_id, updated_at) ON orders       TO agentkit_worker;
GRANT UPDATE (state)                                           ON mandates     TO agentkit_worker;

-- Anchors are signed, so the worker needs a key — but only the anchor one. A view
-- narrows it to that purpose, so mandate, quote and catalog private keys stay out of
-- the worker's reach entirely.
CREATE VIEW anchor_signing_keys AS
  SELECT kid, purpose, state, public_key, private_key, created_at, retired_at
    FROM signing_keys
   WHERE purpose = 'anchor';
ALTER VIEW anchor_signing_keys OWNER TO agentkit_owner;
GRANT SELECT ON anchor_signing_keys TO agentkit_worker;

GRANT DELETE ON intent_nonces TO agentkit_worker;   -- pruning past the intent TTL

-- The job queue creates and owns its own schema on first boot.
DO $$ BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO agentkit_worker', current_database());
END $$;


-- Audit console and the verify CLI. Read only, scoped by RLS.
GRANT SELECT ON ledger         TO agentkit_console;
GRANT SELECT ON ledger_anchor  TO agentkit_console;
GRANT SELECT ON mandates       TO agentkit_console;
GRANT SELECT ON reservations   TO agentkit_console;
GRANT SELECT ON quotes         TO agentkit_console;
GRANT SELECT ON orders         TO agentkit_console;
GRANT SELECT ON webhook_events TO agentkit_console;
GRANT SELECT ON agents         TO agentkit_console;
GRANT SELECT ON auth_events    TO agentkit_console;

-- Deliberately absent: pseudonym_map, so the console cannot resolve a pseudonym to a
-- person; and signing_keys, which holds private key material.


-- INV-18: erasure deletes the pseudonym mapping and leaves every chain verifiable.
-- Only this role can, and no running service holds it.
GRANT SELECT, DELETE ON pseudonym_map TO agentkit_admin;


-- INV-11: restated against each role by name, so removing append-only is a visible edit.
REVOKE UPDATE, DELETE, TRUNCATE ON ledger, ledger_anchor
  FROM agentkit_kernel, agentkit_worker, agentkit_console, agentkit_admin;
