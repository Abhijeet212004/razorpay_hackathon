import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_KERNEL_CONFIG,
  authorize,
} from "../../src/modules/authorization/authorization.service.js";
import { appendOperationsEvent } from "../../src/modules/ledger/ledger.operations.js";
import { signPayload } from "../../src/shared/crypto/ed25519.js";
import { quoteSigningPayload, type SignedQuote } from "../../src/modules/quote/quote.validation.js";
import { ROLES } from "../../src/shared/db/roles.js";
import { silentLogger } from "../../src/shared/logger.js";
import { startTestDatabase, withMerchantContext, type TestDatabase } from "../support/postgres.js";
import { testKernel } from "../support/kernel.js";
import {
  MERCHANT_A,
  makeSignedIntent,
  seedAgent,
  seedMandate,
  seedMerchant,
  seedSigningKey,
  seedSubject,
  type SeededAgent,
  type SeededKey,
} from "../support/fixtures.js";
import { randomBytes, randomUUID } from "node:crypto";

/**
 * INV-08, INV-10 — some decisions have no mandate chain to live on: the mandate is unknown, or its row
 * lock could not be taken. They go on the merchant's operations chain instead, so
 * "every decision writes exactly one ledger entry" holds without exception.
 */
describe("the operations chain", () => {
  let db: TestDatabase;
  let agent: SeededAgent;
  let quoteKey: SeededKey;
  let mandateId: string;

  const lockOptions = {
    merchantId: MERCHANT_A,
    lockTimeoutMs: 3_000,
    statementTimeoutMs: 5_000,
    retryAttempts: 3,
    retryBackoffMs: [10, 40, 160],
  };

  /** A validly signed quote for a mandate that was never written. */
  function unpersistedQuote(forMandateId: string): SignedQuote {
    const now = new Date();
    const quote = {
      quote_id: `qte_${randomUUID().slice(0, 8)}`,
      mandate_id: forMandateId,
      merchant_id: MERCHANT_A,
      basket_hash: randomBytes(32).toString("hex"),
      amount_paise: 10_000n,
      categories: ["groceries"],
      nonce: randomBytes(16).toString("hex"),
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 600_000).toISOString(),
    };
    const signature = signPayload(quoteKey.privateKey, quoteSigningPayload(quote));
    return { quote, kid: quoteKey.kid, signature: signature.toString("hex") };
  }

  /**
   * The stored payload wraps the caller's, so the hash also covers seq, chain_id and
   * kind — those cannot be edited without breaking verification either.
   */
  const operationsEntries = () =>
    withMerchantContext(db.as(ROLES.kernel), MERCHANT_A, async (client) => {
      const result = await client.query<{
        inner: { reason_code?: string; event?: string; operator?: string };
      }>(
        `SELECT payload_redacted -> 'payload' AS inner
           FROM ledger WHERE chain_id = $1 ORDER BY ledger.seq`,
        [MERCHANT_A],
      );
      return result.rows.map((r) => r.inner);
    });

  beforeAll(async () => {
    db = await startTestDatabase();
    await seedMerchant(db.superuser);
    const mandateKey = await seedSigningKey(db.superuser, "mandate");
    quoteKey = await seedSigningKey(db.superuser, "quote");
    agent = await seedAgent(db.superuser);
    const subject = await seedSubject(db.superuser);
    mandateId = await seedMandate(db.superuser, {
      agentId: agent.agentId,
      authEventId: subject.authEventId,
      pseudonym: subject.pseudonym,
      kid: mandateKey.kid,
    });
  });

  afterAll(async () => {
    await db?.stop();
  });

  it("records MND-001 for a mandate that does not exist", async () => {
    const kernel = testKernel(db.as(ROLES.kernel), MERCHANT_A);
    const ghost = `mnd_does_not_exist_${randomUUID().slice(0, 8)}`;
    const quote = unpersistedQuote(ghost);

    const decision = await authorize(kernel, {
      signedIntent: makeSignedIntent({ agent, mandateId: ghost, quote }),
      signedQuote: quote,
    });

    expect(decision.reason_code).toBe("MND-001");
    expect(decision.verdict).toBe("DENY");
    // The denial is chained, not merely returned.
    expect(decision.ledger_seq).not.toBeNull();

    const entries = await operationsEntries();
    expect(entries.some((e) => e.reason_code === "MND-001")).toBe(true);
  });

  it("records SYS-003 when the mandate lock cannot be taken", async () => {
    // Hold the mandate row for longer than the whole retry budget, from outside.
    const holder = new Pool({
      host: db.host,
      port: db.port,
      database: db.database,
      user: ROLES.kernel,
      password: "agentkit_test_pw",
    });
    const held = await holder.connect();

    try {
      await held.query("BEGIN");
      await held.query(`SELECT set_config('agentkit.merchant_id', $1, true)`, [MERCHANT_A]);
      await held.query(`SELECT 1 FROM mandates WHERE mandate_id = $1 FOR UPDATE`, [mandateId]);

      const kernel = testKernel(db.as(ROLES.kernel), MERCHANT_A, {
        config: {
          ...DEFAULT_KERNEL_CONFIG,
          merchantId: MERCHANT_A,
          lockTimeoutMs: 60,
          retryAttempts: 3,
          retryBackoffMs: [5, 10, 20],
        },
      });

      const quote = unpersistedQuote(mandateId);
      const decision = await authorize(kernel, {
        signedIntent: makeSignedIntent({ agent, mandateId, quote }),
        signedQuote: quote,
      });

      expect(decision.reason_code).toBe("SYS-003");
      expect(decision.ledger_seq).not.toBeNull();
    } finally {
      await held.query("ROLLBACK").catch(() => undefined);
      held.release();
      await holder.end();
    }

    const entries = await operationsEntries();
    expect(entries.some((e) => e.reason_code === "SYS-003")).toBe(true);
  });

  it("records operator impersonation on the merchant's own chain", async () => {
    // The merchant reads this in their own console. The party operating the guard layer
    // cannot look at a merchant's ledger without leaving a record the merchant can see.
    const entry = await appendOperationsEvent(db.as(ROLES.kernel), lockOptions, {
      kind: "IMPERSONATION",
      operator: "ops@razorpay",
      reason: "support ticket 4417",
    });

    expect(entry).not.toBeNull();

    const rows = await operationsEntries();
    const impersonation = rows.find((r) => r.event === "operator_impersonation");
    expect(impersonation?.operator).toBe("ops@razorpay");
  });

  it("keeps the operations chain unbroken and verifiable", async () => {
    const { verifyMerchant } = await import("../../src/cli/verify.js");
    const report = await verifyMerchant(db.as(ROLES.console), MERCHANT_A, MERCHANT_A);
    expect(report.ok).toBe(true);
    expect(report.chains[0]?.entries).toBeGreaterThanOrEqual(3);
  });

  it("fails closed with SYS-001 in production mode when something unexpected breaks", async () => {
    // Fail closed in production, fail loud everywhere else. This is the one test that
    // exercises the production behaviour, so the swallowing path stays covered.
    const broken = {
      query: db.as(ROLES.kernel).query.bind(db.as(ROLES.kernel)),
      connect: () => Promise.reject(new TypeError("connection pool exploded")),
    } as unknown as Pool;

    const kernel = testKernel(db.as(ROLES.kernel), MERCHANT_A, {
      pool: broken,
      logger: silentLogger,
      config: {
        ...DEFAULT_KERNEL_CONFIG,
        merchantId: MERCHANT_A,
        rethrowUnexpectedErrors: false,
      },
    });

    const quote = unpersistedQuote(mandateId);
    const decision = await authorize(kernel, {
      signedIntent: makeSignedIntent({ agent, mandateId, quote }),
      signedQuote: quote,
    });

    expect(decision.verdict).toBe("DENY");
    expect(decision.reason_code).toBe("SYS-001");
  });

  it("re-throws in development so a bug crashes the run instead of denying", async () => {
    const broken = {
      query: db.as(ROLES.kernel).query.bind(db.as(ROLES.kernel)),
      connect: () => Promise.reject(new TypeError("connection pool exploded")),
    } as unknown as Pool;

    const kernel = testKernel(db.as(ROLES.kernel), MERCHANT_A, {
      pool: broken,
      logger: silentLogger,
      config: {
        ...DEFAULT_KERNEL_CONFIG,
        merchantId: MERCHANT_A,
        rethrowUnexpectedErrors: true,
      },
    });

    const quote = unpersistedQuote(mandateId);
    await expect(
      authorize(kernel, {
        signedIntent: makeSignedIntent({ agent, mandateId, quote }),
        signedQuote: quote,
      }),
    ).rejects.toThrow(TypeError);
  });
});
