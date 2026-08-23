-- Least-privilege database roles.
--
-- Passwords are applied by the migration runner from the environment, never written
-- into a migration file. NOBYPASSRLS is stated on every role: one role with BYPASSRLS
-- would make merchant isolation unenforceable however the policies are written.

-- Owns every table. Exists so FORCE ROW LEVEL SECURITY has a non-superuser principal to
-- constrain, since a superuser bypasses RLS unconditionally. No service connects as it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentkit_owner') THEN
    CREATE ROLE agentkit_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

-- Kernel and executor. The only writer of history on the request path.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentkit_kernel') THEN
    CREATE ROLE agentkit_kernel LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

-- Background jobs. Resolves reservations and orders; never authorises.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentkit_worker') THEN
    CREATE ROLE agentkit_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

-- Audit console and the verify CLI. Read only, scoped by RLS.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentkit_console') THEN
    CREATE ROLE agentkit_console LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

-- The erasure CLI only. Held by no running service.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentkit_admin') THEN
    CREATE ROLE agentkit_admin LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

-- Grants are additive only. Nothing is reachable by default.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT  USAGE ON SCHEMA public TO agentkit_owner, agentkit_kernel, agentkit_worker,
                                 agentkit_console, agentkit_admin;
GRANT  CREATE ON SCHEMA public TO agentkit_owner;
