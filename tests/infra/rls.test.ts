import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLES, type RoleName } from "../../src/shared/db/roles.js";
import { GENESIS_PREV_HASH, sha256 } from "../../src/shared/crypto/hash.js";
import {
  TEST_ROLE_PASSWORD,
  startTestDatabase,
  withMerchantContext,
  type TestDatabase,
} from "../support/postgres.js";
import { MERCHANT_A, MERCHANT_B } from "../support/fixtures.js";

/**
 * INV-21 — merchant isolation is enforced by PostgreSQL, not by application code.
 *
 * The FORCE half is easy to get wrong and impossible to notice: without it the policy
 * silently does not apply to the table's owner, so every migration and maintenance path
 * reads across merchants while tests that connect as a service role stay green.
 */
describe("row level security with FORCE", () => {
  let db: TestDatabase;

  const rowsFor = (merchantId: string, role: RoleName = ROLES.kernel) =>
    withMerchantContext(db.as(role), merchantId, async (client) => {
      const result = await client.query<{ merchant_id: string }>(
        `SELECT merchant_id FROM ledger ORDER BY chain_id`,
      );
      return result.rows.map((r) => r.merchant_id);
    });

  beforeAll(async () => {
    db = await startTestDatabase();

    // Seeded as superuser, which bypasses RLS — the only way to create the cross-merchant
    // state whose invisibility is the thing under test.
    for (const [chainId, merchantId] of [
      ["mnd_a1", MERCHANT_A],
      ["mnd_a2", MERCHANT_A],
      ["mnd_b1", MERCHANT_B],
    ] as const) {
      await db.superuser.query(
        `INSERT INTO ledger (chain_id, seq, prev_hash, hash, kind, merchant_id, payload_redacted)
         VALUES ($1, 0, $2, $3, 'MANDATE_ISSUED', $4, '{}'::jsonb)`,
        [chainId, GENESIS_PREV_HASH, sha256(Buffer.from(chainId)), merchantId],
      );
    }
  });

  afterAll(async () => {
    await db?.stop();
  });

  it("shows merchant A only its own rows", async () => {
    expect(await rowsFor(MERCHANT_A)).toEqual([MERCHANT_A, MERCHANT_A]);
  });

  it("hides merchant A's rows from merchant B", async () => {
    expect(await rowsFor(MERCHANT_B)).toEqual([MERCHANT_B]);
  });

  it("shows nothing at all when the context is unset — fail closed", async () => {
    // current_setting(..., true) yields NULL, and NULL = merchant_id matches no rows.
    // A caller who forgets to set the context sees an empty database, never everything.
    const client = await db.as(ROLES.kernel).connect();
    try {
      const result = await client.query(`SELECT merchant_id FROM ledger`);
      expect(result.rows).toEqual([]);
    } finally {
      client.release();
    }
  });

  it("refuses to write a row belonging to another merchant", async () => {
    await expect(
      withMerchantContext(db.as(ROLES.kernel), MERCHANT_A, (client) =>
        client.query(
          `INSERT INTO ledger (chain_id, seq, prev_hash, hash, kind, merchant_id, payload_redacted)
           VALUES ('mnd_smuggled', 0, $1, $2, 'DECISION', $3, '{}'::jsonb)`,
          [GENESIS_PREV_HASH, sha256(Buffer.from("smuggled")), MERCHANT_B],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("applies to the table owner too — this is what FORCE means", async () => {
    // agentkit_owner owns every table and is NOSUPERUSER NOBYPASSRLS. Drop FORCE and
    // this is the only assertion in the file that goes red, which is why it is separate.
    const ownerPool = new Pool({
      host: db.host,
      port: db.port,
      database: db.database,
      user: ROLES.owner,
      password: TEST_ROLE_PASSWORD,
    });
    try {
      const visible = await withMerchantContext(ownerPool, MERCHANT_B, async (client) => {
        const result = await client.query<{ merchant_id: string }>(
          `SELECT merchant_id FROM ledger`,
        );
        return result.rows.map((r) => r.merchant_id);
      });
      expect(visible, "the owner must not see across merchants").toEqual([MERCHANT_B]);
    } finally {
      await ownerPool.end();
    }
  });

  it("has ENABLE and FORCE set on every tenant table", async () => {
    const result = await db.superuser.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE relname = ANY($1::text[])
        ORDER BY relname`,
      [["ledger", "mandates", "reservations", "quotes", "orders", "webhook_events",
        "merchants", "catalog_items", "challenges", "refunds", "rate_limit_buckets"]],
    );

    expect(result.rows).toHaveLength(11);
    for (const row of result.rows) {
      expect(row.relrowsecurity, `${row.relname} must ENABLE row level security`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} must FORCE row level security`).toBe(true);
    }
  });

  it("grants BYPASSRLS to no role", async () => {
    const result = await db.superuser.query<{ rolname: string }>(
      `SELECT rolname FROM pg_roles WHERE rolbypassrls AND rolname LIKE 'agentkit%'`,
    );
    expect(result.rows.map((r) => r.rolname)).toEqual([]);
  });
});
