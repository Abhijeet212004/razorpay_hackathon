import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authorize } from "../../src/modules/authorization/authorization.service.js";
import type { Decision } from "../../src/modules/authorization/authorization.validation.js";
import { ROLES } from "../../src/shared/db/roles.js";
import { startTestDatabase, withMerchantContext, type TestDatabase } from "../support/postgres.js";
import { testKernel } from "../support/kernel.js";
import {
  MERCHANT_A,
  issueQuote,
  makeSignedIntent,
  seedAgent,
  seedCapturedReservation,
  seedMandate,
  seedMerchant,
  seedSigningKey,
  seedSubject,
  type SeededAgent,
  type SeededKey,
} from "../support/fixtures.js";

/**
 * INV-05 — fifty concurrent intents against ₹900 of headroom.
 *
 * The bug this catches is silent. Counting only settled payments looks correct:
 *
 *   Intent A: lock, settled spend ₹9,000, +₹900 passes, commit, release
 *   Intent B: lock, settled spend still ₹9,000 because A's webhook has not arrived,
 *             +₹900 passes, commit
 *   Result:   ₹9,900 authorised against a ₹9,000 remaining cap, with no error at all
 *
 * The row lock stops simultaneous reads. It does not stop sequential reads of stale
 * settled-only state, and settlement lags authorisation by seconds to minutes.
 *
 * No webhooks are delivered during this run, so nothing ever reaches 'captured'. A
 * settled-only cap query would therefore read the same total fifty times and admit all
 * fifty. Remove the reservation write and this goes red; remove the row lock and this
 * goes red.
 */

const INTENT_COUNT = 50;
const INTENT_AMOUNT = 90_000n;
const HEADROOM = 90_000n;

/**
 * The cumulative cap is the only rule that can bind here.
 *
 *   cap                  ₹9,900
 *   prior captured       ₹9,000  (10 orders, one day old, inside the 30-day window)
 *   headroom             ₹900    one intent, not two
 *
 * The ten prior orders also give the mandate history, so the first-purchase step-up
 * cannot fire and ₹900 is unremarkable for the anomaly rule. Velocity is raised well
 * above 50 so a velocity denial cannot masquerade as a cap denial.
 */
const CUMULATIVE_CAP = 990_000n;
const PRIOR_ORDERS = 10;
const PRIOR_ORDER_AMOUNT = 90_000n;

describe("fifty concurrent intents against ₹900 of headroom", () => {
  let db: TestDatabase;
  let agent: SeededAgent;
  let quoteKey: SeededKey;
  let mandateId: string;

  beforeAll(async () => {
    db = await startTestDatabase();
    await seedMerchant(db.superuser);

    const mandateKey = await seedSigningKey(db.superuser, "mandate");
    quoteKey = await seedSigningKey(db.superuser, "quote");
    agent = await seedAgent(db.superuser);
    const subject = await seedSubject(db.superuser);

    mandateId = await seedMandate(db.superuser, {
      merchantId: MERCHANT_A,
      agentId: agent.agentId,
      authEventId: subject.authEventId,
      pseudonym: subject.pseudonym,
      kid: mandateKey.kid,
      cumulativePaise: CUMULATIVE_CAP,
      perTransactionPaise: 500_000n,
      silentThresholdPaise: 500_000n,
      velocityPerHour: 1_000,
      cumulativeWindow: "30 days",
    });

    for (let i = 0; i < PRIOR_ORDERS; i += 1) {
      await seedCapturedReservation(db.superuser, {
        mandateId,
        merchantId: MERCHANT_A,
        amountPaise: PRIOR_ORDER_AMOUNT,
        ageMs: 86_400_000,
      });
    }
  });

  afterAll(async () => {
    await db?.stop();
  });

  it("admits exactly one and denies forty-nine with LMT-002", async () => {
    const kernel = testKernel(db.as(ROLES.kernel), MERCHANT_A);

    // Each intent gets its own quote and nonce: quotes are single-use, and a shared one
    // would deny with INT-002 for reasons unrelated to caps.
    const requests = await Promise.all(
      Array.from({ length: INTENT_COUNT }, async () => {
        const quote = await issueQuote(db.superuser, {
          mandateId,
          merchantId: MERCHANT_A,
          amountPaise: INTENT_AMOUNT,
          key: quoteKey,
        });
        return {
          signedIntent: makeSignedIntent({ agent, mandateId, quote }),
          signedQuote: quote,
        };
      }),
    );

    const settled = await Promise.allSettled(
      requests.map((request) => authorize(kernel, request)),
    );

    const failures = settled.filter((r) => r.status === "rejected");
    expect(
      failures.map((f) => String((f as PromiseRejectedResult).reason)),
      "authorize must return a Decision for every intent, never throw",
    ).toEqual([]);

    const decisions = settled
      .filter((r): r is PromiseFulfilledResult<Decision> => r.status === "fulfilled")
      .map((r) => r.value);

    const allows = decisions.filter((d) => d.verdict === "ALLOW");
    const denies = decisions.filter((d) => d.verdict === "DENY");
    const stepUps = decisions.filter((d) => d.verdict === "STEP_UP");

    expect(stepUps, "nothing in this fixture should trigger a step-up").toHaveLength(0);
    expect(allows, "exactly one intent fits in ₹900 of headroom").toHaveLength(1);
    expect(allows[0]?.reason_code).toBe("OK-000");
    expect(denies).toHaveLength(INTENT_COUNT - 1);

    // SYS-003 here would mean the lock retry budget was exhausted, which is a defect
    // rather than a cap denial.
    const denyCodes = new Set(denies.map((d) => d.reason_code));
    expect([...denyCodes], "every denial must be the cumulative cap").toEqual(["LMT-002"]);
  });

  it("holds exactly ₹900 in reservations", async () => {
    await withMerchantContext(db.as(ROLES.kernel), MERCHANT_A, async (client) => {
      const held = await client.query<{ total: string; rows: string }>(
        `SELECT COALESCE(SUM(amount_paise), 0)::text AS total, COUNT(*)::text AS rows
           FROM reservations
          WHERE mandate_id = $1 AND state = 'held'`,
        [mandateId],
      );
      expect(BigInt(held.rows[0]!.total)).toBe(HEADROOM);
      expect(Number(held.rows[0]!.rows)).toBe(1);

      // The cap counts held and captured together. After the run the mandate sits
      // exactly on its cap, never above it.
      const counted = await client.query<{ total: string }>(
        `SELECT COALESCE(SUM(amount_paise), 0)::text AS total
           FROM reservations
          WHERE mandate_id = $1
            AND state IN ('held', 'captured')
            AND created_at > now() - INTERVAL '30 days'`,
        [mandateId],
      );
      expect(BigInt(counted.rows[0]!.total)).toBe(CUMULATIVE_CAP);
    });
  });

  it("burns every nonce and consumes only the quote that was allowed", async () => {
    await withMerchantContext(db.as(ROLES.kernel), MERCHANT_A, async (client) => {
      // A denied intent has still been spent. The burn sits inside the transaction so a
      // rolled-back attempt does not waste the nonce; a committed denial does.
      const nonces = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM intent_nonces WHERE mandate_id = $1`,
        [mandateId],
      );
      expect(Number(nonces.rows[0]!.count)).toBe(INTENT_COUNT);

      const consumed = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM quotes
          WHERE mandate_id = $1 AND consumed_at IS NOT NULL`,
        [mandateId],
      );
      expect(Number(consumed.rows[0]!.count)).toBe(1);
    });
  });

  it("writes one decision entry per intent, on an unbroken chain", async () => {
    await withMerchantContext(db.as(ROLES.kernel), MERCHANT_A, async (client) => {
      const decisions = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ledger WHERE chain_id = $1 AND kind = 'DECISION'`,
        [mandateId],
      );
      expect(Number(decisions.rows[0]!.count)).toBe(INTENT_COUNT);

      // Contiguous from genesis, no gaps and no duplicates. A fork would have been
      // refused by the unique constraint before reaching here.
      const chain = await client.query<{ seq_text: string }>(
        // Aliased: an output column named `seq` would capture ORDER BY and sort the
        // sequence as text, where '9' comes after '10'.
        `SELECT seq::text AS seq_text FROM ledger WHERE chain_id = $1 ORDER BY ledger.seq`,
        [mandateId],
      );
      const seqs = chain.rows.map((r) => Number(r.seq_text));
      expect(seqs).toEqual(seqs.map((_, index) => index));
    });
  });
});
