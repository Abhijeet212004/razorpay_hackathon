import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLES } from "../../src/shared/db/roles.js";
import { GENESIS_PREV_HASH } from "../../src/shared/crypto/hash.js";
import {
  SQLSTATE,
  sqlstateInMerchantContext,
  startTestDatabase,
  type TestDatabase,
} from "../support/postgres.js";
import { MERCHANT_A, seedSigningKey } from "../support/fixtures.js";

/**
 * INV-11, INV-18 — nothing in the application will catch a wrong GRANT, because a wrong GRANT makes the
 * application work better. These tests are the only thing between a typo and a mutable
 * ledger.
 */
describe("the grant matrix", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
  });

  afterAll(async () => {
    await db?.stop();
  });

  const attempt = (
    role: (typeof ROLES)[keyof typeof ROLES],
    sql: string,
    params: unknown[] = [],
  ) =>
    sqlstateInMerchantContext(db.as(role), MERCHANT_A, (client) => client.query(sql, params));

  it("agentkit_console cannot INSERT into the ledger", async () => {
    const code = await attempt(
      ROLES.console,
      `INSERT INTO ledger (chain_id, seq, prev_hash, hash, kind, merchant_id, payload_redacted)
       VALUES ('mnd_x', 0, $1, $2, 'DECISION', $3, '{}'::jsonb)`,
      [GENESIS_PREV_HASH, Buffer.alloc(32, 1), MERCHANT_A],
    );
    expect(code, "the console is read-only").toBe(SQLSTATE.INSUFFICIENT_PRIVILEGE);
  });

  it("agentkit_kernel cannot UPDATE the ledger", async () => {
    const code = await attempt(ROLES.kernel, `UPDATE ledger SET kind = 'DECISION'`);
    expect(code, "the ledger is append-only from every role").toBe(
      SQLSTATE.INSUFFICIENT_PRIVILEGE,
    );
  });

  it("agentkit_kernel cannot DELETE from the ledger", async () => {
    const code = await attempt(ROLES.kernel, `DELETE FROM ledger`);
    expect(code, "corrections are compensating entries, never deletions").toBe(
      SQLSTATE.INSUFFICIENT_PRIVILEGE,
    );
  });

  it("no role can UPDATE or DELETE the ledger or its anchors", async () => {
    const roles = [ROLES.kernel, ROLES.worker, ROLES.console, ROLES.admin] as const;
    const tables = [
      { name: "ledger", column: "merchant_id" },
      { name: "ledger_anchor", column: "kid" },
    ] as const;

    for (const role of roles) {
      for (const table of tables) {
        expect(
          await attempt(role, `UPDATE ${table.name} SET ${table.column} = 'x'`),
          `${role} must not UPDATE ${table.name}`,
        ).toBe(SQLSTATE.INSUFFICIENT_PRIVILEGE);
        expect(
          await attempt(role, `DELETE FROM ${table.name}`),
          `${role} must not DELETE from ${table.name}`,
        ).toBe(SQLSTATE.INSUFFICIENT_PRIVILEGE);
      }
    }
  });

  it("holds no UPDATE or DELETE privilege in the catalog either", async () => {
    // The statement-level tests above prove the behaviour; this proves the grant, so a
    // future column rename cannot quietly turn a privilege failure into a syntax failure.
    const result = await db.superuser.query<{
      grantee: string;
      table_name: string;
      privilege_type: string;
    }>(
      `SELECT grantee, table_name, privilege_type
         FROM information_schema.role_table_grants
        WHERE table_name IN ('ledger', 'ledger_anchor')
          AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')
          AND grantee LIKE 'agentkit_%'
          AND grantee <> 'agentkit_owner'`,
    );
    expect(result.rows, "no application role may mutate history").toEqual([]);
  });

  it("agentkit_kernel cannot rewrite a mandate's caps", async () => {
    // Column-level UPDATE grants: the kernel may revoke a mandate and move the chain
    // head, and may not raise the limits it is about to be checked against.
    const code = await attempt(
      ROLES.kernel,
      `UPDATE mandates SET cumulative_paise = 999999999`,
    );
    expect(code).toBe(SQLSTATE.INSUFFICIENT_PRIVILEGE);
  });

  it("agentkit_console cannot resolve a pseudonym to a person", async () => {
    // The console shows pseudonymous identifiers. Joining them back to a phone number
    // would make the pseudonymisation decorative.
    const code = await attempt(ROLES.console, `SELECT * FROM pseudonym_map`);
    expect(code).toBe(SQLSTATE.INSUFFICIENT_PRIVILEGE);
  });

  it("only agentkit_admin can DELETE from pseudonym_map", async () => {
    expect(await attempt(ROLES.kernel, `DELETE FROM pseudonym_map`)).toBe(
      SQLSTATE.INSUFFICIENT_PRIVILEGE,
    );
    expect(await attempt(ROLES.worker, `DELETE FROM pseudonym_map`)).toBe(
      SQLSTATE.INSUFFICIENT_PRIVILEGE,
    );
    // Erasure deletes the mapping and leaves the chain verifiable.
    expect(await attempt(ROLES.admin, `DELETE FROM pseudonym_map`)).toBeUndefined();
  });

  it("agentkit_worker sees the anchor key and no other private key", async () => {
    // The worker signs anchors, so it needs one key. A view narrows it to that purpose:
    // forging an anchor cannot forge history, because every per-mandate chain
    // independently contradicts a false checkpoint.
    expect(await attempt(ROLES.worker, `SELECT private_key FROM signing_keys`)).toBe(
      SQLSTATE.INSUFFICIENT_PRIVILEGE,
    );
    expect(await attempt(ROLES.worker, `SELECT private_key FROM anchor_signing_keys`)).toBeUndefined();

    await seedSigningKey(db.superuser, "anchor");
    await seedSigningKey(db.superuser, "quote");

    const visible = await db.superuser.query<{ purpose: string }>(
      `SELECT DISTINCT purpose FROM anchor_signing_keys`,
    );
    expect(visible.rows.map((r) => r.purpose)).toEqual(["anchor"]);
  });

  it("agentkit_console cannot read private key material", async () => {
    const code = await attempt(ROLES.console, `SELECT private_key FROM signing_keys`);
    expect(code).toBe(SQLSTATE.INSUFFICIENT_PRIVILEGE);
  });
});
