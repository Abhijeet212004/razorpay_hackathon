import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GENESIS_PREV_HASH, sha256 } from "../../src/shared/crypto/hash.js";
import { generateKeyPair } from "../../src/shared/crypto/ed25519.js";
import { SQLSTATE, sqlstateFrom, startTestDatabase, type TestDatabase } from "../support/postgres.js";
import { MERCHANT_A } from "../support/fixtures.js";

/**
 * INV-11, INV-16 — constraints that carry an invariant.  Each one is a claim the database makes on the
 * application's behalf, and each is here because losing it would be silent.
 */
describe("schema constraints that carry invariants", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
  });

  afterAll(async () => {
    await db?.stop();
  });

  const appendGenesis = (chainId: string) =>
    db.superuser.query(
      `INSERT INTO ledger (chain_id, seq, prev_hash, hash, kind, merchant_id, payload_redacted)
       VALUES ($1, 0, $2, $3, 'MANDATE_ISSUED', $4, '{}'::jsonb)`,
      [chainId, GENESIS_PREV_HASH, sha256(Buffer.from(`${chainId}:0`)), MERCHANT_A],
    );

  it("two entries claiming the same predecessor cannot both be written", async () => {
    const chainId = "mnd_fork";
    await appendGenesis(chainId);

    const head = sha256(Buffer.from(`${chainId}:0`));

    // The honest next entry.
    await db.superuser.query(
      `INSERT INTO ledger (chain_id, seq, prev_hash, hash, kind, merchant_id, payload_redacted)
       VALUES ($1, 1, $2, $3, 'DECISION', $4, '{}'::jsonb)`,
      [chainId, head, sha256(Buffer.from(`${chainId}:1a`)), MERCHANT_A],
    );

    // A second entry claiming the same predecessor. This is the fork, and it is
    // unwritable — not rejected by application code, refused by the storage layer.
    const code = await sqlstateFrom(() =>
      db.superuser.query(
        `INSERT INTO ledger (chain_id, seq, prev_hash, hash, kind, merchant_id, payload_redacted)
         VALUES ($1, 2, $2, $3, 'DECISION', $4, '{}'::jsonb)`,
        [chainId, head, sha256(Buffer.from(`${chainId}:1b`)), MERCHANT_A],
      ),
    );
    expect(code, "ledger_no_fork must refuse a second entry on the same predecessor").toBe(
      SQLSTATE.UNIQUE_VIOLATION,
    );
  });

  it("a chain cannot have two genesis entries", async () => {
    await appendGenesis("mnd_twice");
    const code = await sqlstateFrom(() => appendGenesis("mnd_twice"));
    expect(code).toBe(SQLSTATE.UNIQUE_VIOLATION);
  });

  it("a purpose can have only one active signing key", async () => {
    const first = generateKeyPair();
    const second = generateKeyPair();

    await db.superuser.query(
      `INSERT INTO signing_keys (kid, purpose, state, public_key) VALUES ('kid_q1', 'quote', 'active', $1)`,
      [first.publicKey],
    );

    const code = await sqlstateFrom(() =>
      db.superuser.query(
        `INSERT INTO signing_keys (kid, purpose, state, public_key) VALUES ('kid_q2', 'quote', 'active', $1)`,
        [second.publicKey],
      ),
    );
    expect(code, "signing_keys_one_active_per_purpose must hold").toBe(SQLSTATE.UNIQUE_VIOLATION);

    // Retiring the first frees the slot: verification accepts retired keys, issuance
    // uses only the active one.
    await db.superuser.query(
      `UPDATE signing_keys SET state = 'retired', retired_at = now() WHERE kid = 'kid_q1'`,
    );
    await expect(
      db.superuser.query(
        `INSERT INTO signing_keys (kid, purpose, state, public_key) VALUES ('kid_q2', 'quote', 'active', $1)`,
        [second.publicKey],
      ),
    ).resolves.toBeDefined();
  });

  it("chain_id must equal mandate_id", async () => {
    const code = await sqlstateFrom(() =>
      db.superuser.query(
        `INSERT INTO mandates (
           mandate_id, merchant_id, subject_pseudonym, agent_id, auth_event_id,
           per_transaction_paise, cumulative_paise, cumulative_window, velocity_per_hour,
           silent_threshold_paise, scope, state, not_before, not_after, chain_id, kid, signature
         ) VALUES (
           'mnd_a', $1, 'psu_x', 'agt_x', 'aev_x',
           1, 1, '30 days'::interval, 1,
           1, '{}'::jsonb, 'live', now(), now() + interval '1 day', 'mnd_DIFFERENT', 'kid_x', '\\x00'::bytea
         )`,
        [MERCHANT_A],
      ),
    );
    expect(code, "prevents a global chain creeping back in").toBe(
      SQLSTATE.CHECK_VIOLATION,
    );
  });

  it("a ledger hash must be exactly 32 bytes", async () => {
    const code = await sqlstateFrom(() =>
      db.superuser.query(
        `INSERT INTO ledger (chain_id, seq, prev_hash, hash, kind, merchant_id, payload_redacted)
         VALUES ('mnd_short', 0, $1, $2, 'DECISION', $3, '{}'::jsonb)`,
        [GENESIS_PREV_HASH, Buffer.alloc(16, 7), MERCHANT_A],
      ),
    );
    expect(code).toBe(SQLSTATE.CHECK_VIOLATION);
  });

  it("a reservation cannot be resolved and still held", async () => {
    // The cap query counts state, and a row whose state and timestamps disagree would be
    // counted by one and skipped by the other.
    const code = await sqlstateFrom(() =>
      db.superuser.query(
        `INSERT INTO reservations (reservation_id, mandate_id, merchant_id, intent_id, amount_paise, state, resolved_at)
         VALUES ('rsv_bad', 'mnd_nope', $1, 'int_bad', 100, 'held', now())`,
        [MERCHANT_A],
      ),
    );
    // Either the CHECK or the foreign key refuses it; both are correct refusals.
    expect([SQLSTATE.CHECK_VIOLATION, "23503"]).toContain(code);
  });

  it("an unknown ledger kind cannot be written", async () => {
    const code = await sqlstateFrom(() =>
      db.superuser.query(
        `INSERT INTO ledger (chain_id, seq, prev_hash, hash, kind, merchant_id, payload_redacted)
         VALUES ('mnd_kind', 0, $1, $2, 'SOMETHING_NEW', $3, '{}'::jsonb)`,
        [GENESIS_PREV_HASH, sha256(Buffer.from("k")), MERCHANT_A],
      ),
    );
    expect(code).toBe(SQLSTATE.CHECK_VIOLATION);
  });
});
