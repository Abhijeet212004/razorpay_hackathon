import { randomUUID } from "node:crypto";
import { Client, Pool, type PoolClient } from "pg";
import { inject } from "vitest";
import { migrate } from "../../src/shared/db/migrate.js";
import { ALL_ROLES, type RoleName } from "../../src/shared/db/roles.js";

/**
 * A real PostgreSQL 16, every time. A mocked database would let both concurrent
 * transactions pass, going green on the precise bug the design exists to prevent.
 *
 * The container starts once for the run; each suite gets a freshly migrated database of
 * its own inside it.
 */

/** One password for every role in tests.  Real deployments use distinct secrets. */
export const TEST_ROLE_PASSWORD = "agentkit_test_pw";

export interface TestDatabase {
  readonly database: string;
  readonly host: string;
  readonly port: number;
  /** Superuser pool.  Use only for fixtures that must bypass RLS. */
  readonly superuser: Pool;
  /** A pool connected as the given role, created on first use and reused. */
  as(role: RoleName): Pool;
  stop(): Promise<void>;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const server = inject("postgres");
  const database = `agentkit_${randomUUID().replaceAll("-", "")}`;

  const admin = new Client({
    host: server.host,
    port: server.port,
    database: server.adminDatabase,
    user: server.adminUser,
    password: server.adminPassword,
  });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  await admin.end();

  const bootstrap = new Client({
    host: server.host,
    port: server.port,
    database,
    user: server.adminUser,
    password: server.adminPassword,
  });
  await bootstrap.connect();
  const passwords = Object.fromEntries(
    ALL_ROLES.map((role) => [role, TEST_ROLE_PASSWORD]),
  ) as Record<RoleName, string>;
  await migrate(bootstrap, passwords);
  await bootstrap.end();

  const connection = { host: server.host, port: server.port, database };
  const superuser = new Pool({
    ...connection,
    user: server.adminUser,
    password: server.adminPassword,
  });
  const rolePools = new Map<RoleName, Pool>();

  return {
    database,
    host: server.host,
    port: server.port,
    superuser,
    as(role: RoleName): Pool {
      let pool = rolePools.get(role);
      if (pool === undefined) {
        pool = new Pool({
          ...connection,
          user: role,
          password: TEST_ROLE_PASSWORD,
          max: 60, // the concurrency test opens 50 simultaneous transactions
        });
        rolePools.set(role, pool);
      }
      return pool;
    },
    async stop(): Promise<void> {
      await Promise.all([...rolePools.values()].map((p) => p.end()));
      await superuser.end();

      const dropper = new Client({
        host: server.host,
        port: server.port,
        database: server.adminDatabase,
        user: server.adminUser,
        password: server.adminPassword,
      });
      await dropper.connect();
      await dropper.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await dropper.end();
    },
  };
}

/** Postgres SQLSTATE codes this suite asserts on by name rather than by number. */
export const SQLSTATE = {
  INSUFFICIENT_PRIVILEGE: "42501",
  UNIQUE_VIOLATION: "23505",
  FOREIGN_KEY_VIOLATION: "23503",
  CHECK_VIOLATION: "23514",
  RLS_VIOLATION: "42501",
} as const;

export function sqlstateOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/** Run `fn` and return the SQLSTATE it raised, or undefined if it did not raise. */
export async function sqlstateFrom(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return sqlstateOf(error);
  }
}

/**
 * Run `fn` inside a transaction with the RLS merchant context set.
 *
 * Two details that are easy to get wrong and silent when wrong:
 *
 *  - `SET LOCAL` takes no bind parameters, so the context is set with
 *    `set_config(..., is_local => true)`, which has identical semantics.
 *  - `SET LOCAL` outside a transaction does nothing at all.  On a pooled connection that
 *    means the policy sees no setting, every query returns zero rows, and a test can
 *    appear to pass because the data was invisible rather than because it was isolated.
 *    The BEGIN is not optional.
 */
export async function withMerchantContext<T>(
  pool: Pool,
  merchantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('agentkit.merchant_id', $1, true)`, [merchantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** As above, but returns the SQLSTATE the body raised instead of rethrowing. */
export async function sqlstateInMerchantContext(
  pool: Pool,
  merchantId: string,
  fn: (client: PoolClient) => Promise<unknown>,
): Promise<string | undefined> {
  try {
    await withMerchantContext(pool, merchantId, fn);
    return undefined;
  } catch (error) {
    return sqlstateOf(error);
  }
}
