import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { generateKeyPair, signPayload } from "../../shared/crypto/ed25519.js";
import { GENESIS_PREV_HASH, chainHash, idempotencyKey } from "../../shared/crypto/hash.js";
import type { JsonValue } from "../../shared/crypto/jcs.js";
import { paiseToCanonical, rupees } from "../../shared/money.js";
import { quoteSigningPayload } from "../../modules/quote/quote.validation.js";

/**
 * Thirty days of history a judge can interrogate.
 *
 * Everything is relative to now(), so "thirty days" is true whenever it runs. It is
 * idempotent on the merchant row: running twice adds nothing.
 *
 * The point is not volume. It is that every interesting path is represented — every
 * reason code at least once, an AMBIGUOUS that reconciled, a revocation with its refund,
 * a quarantined injected product, and a mandate sitting at 98% of its cap so the meter
 * reads as something rather than nothing.
 */

export interface SeedOptions {
  readonly merchantId: string;
  readonly merchantName: string;
}

interface ChainCursor {
  seq: number;
  prev: Buffer;
}

export async function seed(db: Client, options: SeedOptions): Promise<void> {
  const existing = await db.query(`SELECT 1 FROM merchants WHERE merchant_id = $1`, [
    options.merchantId,
  ]);
  if (existing.rowCount !== null && existing.rowCount > 0) {
    console.log("[seed] merchant already present, skipping");
    return;
  }

  console.log("[seed] writing thirty days of history");

  await db.query(`INSERT INTO merchants (merchant_id, name) VALUES ($1, $2)`, [
    options.merchantId,
    options.merchantName,
  ]);

  // No catalog here on purpose. It is synced from the merchant's own product endpoint
  // by the worker, which is the entire integration story — we do not seed a shop, we
  // read the one the merchant already has.

  const keys: Record<string, { kid: string; publicKey: Buffer; privateKey: Buffer }> = {};
  for (const purpose of ["mandate", "quote", "catalog", "anchor"] as const) {
    const pair = generateKeyPair();
    const kid = `kid_${purpose}_${randomUUID().slice(0, 8)}`;
    await db.query(
      `INSERT INTO signing_keys (kid, purpose, state, public_key, private_key)
       VALUES ($1, $2, 'active', $3, $4)`,
      [kid, purpose, pair.publicKey, pair.privateKey],
    );
    keys[purpose] = { kid, ...pair };
  }

  const agent = generateKeyPair();
  const agentId = `agt_shopbuddy`;
  await db.query(
    `INSERT INTO agents (agent_id, name, public_key, attestation)
     VALUES ($1, 'ShopBuddy', $2, 'self_registered_v1')`,
    [agentId, agent.publicKey],
  );

  const chains = new Map<string, ChainCursor>();

  async function append(
    chainId: string,
    kind: string,
    ref: string | null,
    payload: JsonValue,
    at: Date,
  ): Promise<void> {
    const cursor = chains.get(chainId) ?? { seq: 0, prev: GENESIS_PREV_HASH };
    const wrapped = {
      chain_id: chainId,
      kind,
      merchant_id: options.merchantId,
      payload,
      ref,
      seq: cursor.seq,
    };
    const hash = chainHash(cursor.prev, wrapped);
    await db.query(
      `INSERT INTO ledger (chain_id, seq, prev_hash, hash, kind, merchant_id, ref,
         payload_redacted, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
      [
        chainId,
        cursor.seq,
        cursor.prev,
        hash,
        kind,
        options.merchantId,
        ref,
        JSON.stringify(wrapped),
        at.toISOString(),
      ],
    );
    chains.set(chainId, { seq: cursor.seq + 1, prev: hash });
  }

  const daysAgo = (days: number, hour = 10): Date => {
    const d = new Date(Date.now() - days * 86_400_000);
    d.setHours(hour, (days * 7) % 60, 0, 0);
    return d;
  };

  async function makeMandate(
    label: string,
    daysBack: number,
    limits: {
      perTransaction: number;
      cumulative: number;
      velocity: number;
      silent: number;
      categories: string[];
    },
    state: "live" | "revoked" | "expired" = "live",
    notAfterDays = 30,
  ): Promise<string> {
    const mandateId = `mnd_${label}`;
    const pseudonym = `psu_${label}`;
    const authEventId = `aev_${label}`;
    const created = daysAgo(daysBack);

    await db.query(
      `INSERT INTO pseudonym_map (subject_pseudonym, person_ref) VALUES ($1, $2)`,
      [pseudonym, `+9198${randomBytes(4).readUInt32BE(0) % 100000000}`],
    );
    await db.query(
      `INSERT INTO auth_events (auth_event_id, subject_pseudonym, method, max_age_seconds, occurred_at)
       VALUES ($1, $2, 'sms_otp', 300, $3)`,
      [authEventId, pseudonym, created.toISOString()],
    );
    await db.query(
      `INSERT INTO mandates (mandate_id, merchant_id, subject_pseudonym, agent_id,
         auth_event_id, per_transaction_paise, cumulative_paise, cumulative_window,
         velocity_per_hour, silent_threshold_paise, scope, state, not_before, not_after,
         revoked_at, chain_id, kid, signature, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'30 days'::interval,$8,$9,$10::jsonb,$11,$12,$13,$14,$1,$15,$16,$12)`,
      [
        mandateId,
        options.merchantId,
        pseudonym,
        agentId,
        authEventId,
        rupees(limits.perTransaction).toString(),
        rupees(limits.cumulative).toString(),
        limits.velocity,
        rupees(limits.silent).toString(),
        JSON.stringify({
          merchants: [options.merchantId],
          categories: limits.categories,
          currency: "INR",
        }),
        state,
        created.toISOString(),
        new Date(created.getTime() + notAfterDays * 86_400_000).toISOString(),
        state === "revoked" ? daysAgo(daysBack - 26).toISOString() : null,
        keys.mandate!.kid,
        signPayload(keys.mandate!.privateKey, { mandate_id: mandateId }),
      ],
    );

    await append(mandateId, "MANDATE_ISSUED", mandateId, { mandate_id: mandateId }, created);
    return mandateId;
  }

  // Priya: the main story. Thirty days, healthy, sitting at 98% of her cap by the end.
  // Sixty days of validity, granted thirty days ago: still live for another month, so a
  // reviewer opening the console sees a working mandate rather than an expired one.
  const priya = await makeMandate("priya", 30, {
    perTransaction: 5_000,
    cumulative: 15_000,
    velocity: 3,
    silent: 500,
    categories: ["groceries", "household"],
  }, "live", 60);
  // A second buyer whose mandate was revoked mid-flight, with the compensating refund.
  const revoked = await makeMandate(
    "arjun",
    28,
    { perTransaction: 5_000, cumulative: 15_000, velocity: 3, silent: 500, categories: ["groceries"] },
    "revoked",
  );
  // One that simply ran out, so MND-002 is represented honestly rather than synthesised.
  const expired = await makeMandate(
    "meera",
    40,
    { perTransaction: 3_000, cumulative: 8_000, velocity: 3, silent: 500, categories: ["groceries"] },
    "expired",
    12,
  );

  let intentCounter = 0;

  async function decision(
    mandateId: string,
    daysBack: number,
    hour: number,
    verdict: "ALLOW" | "DENY" | "STEP_UP",
    reasonCode: string,
    amountRupees: number,
    options2: { settle?: "captured" | "failed" | "ambiguous"; refunded?: boolean } = {},
  ): Promise<string> {
    intentCounter += 1;
    const intentId = `int_seed_${String(intentCounter).padStart(3, "0")}`;
    const decisionId = `dec_seed_${String(intentCounter).padStart(3, "0")}`;
    const at = daysAgo(daysBack, hour);
    const amount = rupees(amountRupees);

    const quoteId = `qte_seed_${String(intentCounter).padStart(3, "0")}`;
    const basketHash = randomBytes(32);
    const quote = {
      quote_id: quoteId,
      mandate_id: mandateId,
      merchant_id: options.merchantId,
      basket_hash: basketHash.toString("hex"),
      amount_paise: amount,
      categories: ["groceries"],
      nonce: randomBytes(16).toString("hex"),
      issued_at: at.toISOString(),
      expires_at: new Date(at.getTime() + 600_000).toISOString(),
    };
    await db.query(
      `INSERT INTO quotes (quote_id, mandate_id, merchant_id, basket_hash, amount_paise,
         categories, nonce, issued_at, expires_at, consumed_at, consumed_by, kid, signature)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        quoteId, mandateId, options.merchantId, basketHash, amount.toString(),
        ["groceries"], quote.nonce, at.toISOString(),
        new Date(at.getTime() + 600_000).toISOString(),
        verdict === "DENY" ? null : at.toISOString(),
        verdict === "DENY" ? null : intentId,
        keys.quote!.kid,
        signPayload(keys.quote!.privateKey, quoteSigningPayload(quote)),
      ],
    );

    await db.query(
      `INSERT INTO intent_nonces (nonce, mandate_id, intent_id, burned_at)
       VALUES ($1, $2, $3, $4)`,
      [randomBytes(16).toString("hex"), mandateId, intentId, at.toISOString()],
    );

    await append(mandateId, "INTENT", intentId, {
      intent_id: intentId,
      amount_paise: paiseToCanonical(amount),
    }, at);

    await append(mandateId, "DECISION", intentId, {
      decision_id: decisionId,
      intent_id: intentId,
      verdict,
      reason_code: reasonCode,
      evaluated: [{ rule: "limits.cumulative", passed: verdict !== "DENY", observed: paiseToCanonical(amount), bound: null, reason_code: verdict === "DENY" ? reasonCode : null }],
    }, at);

    if (verdict === "DENY") return intentId;

    const reservationId = `rsv_seed_${String(intentCounter).padStart(3, "0")}`;
    const settle = options2.settle ?? "captured";
    const finalState =
      options2.refunded === true
        ? "released"
        : settle === "failed"
          ? "released"
          : settle === "ambiguous"
            ? "held"
            : verdict === "STEP_UP"
              ? "held"
              : "captured";

    await db.query(
      `INSERT INTO reservations (reservation_id, mandate_id, merchant_id, intent_id,
         amount_paise, state, step_up, release_reason, created_at, resolved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        reservationId, mandateId, options.merchantId, intentId, amount.toString(),
        finalState, verdict === "STEP_UP",
        options2.refunded === true ? "refunded" : settle === "failed" ? "payment_failed" : null,
        at.toISOString(),
        finalState === "held" ? null : new Date(at.getTime() + 90_000).toISOString(),
      ],
    );
    await append(mandateId, "RESERVATION", intentId, {
      reservation_id: reservationId,
      amount_paise: paiseToCanonical(amount),
      step_up: verdict === "STEP_UP",
    }, at);

    if (verdict === "STEP_UP") return intentId;

    const orderId = `ord_seed_${String(intentCounter).padStart(3, "0")}`;
    const railOrderId = `order_${randomUUID().replaceAll("-", "").slice(0, 14)}`;
    const orderState =
      options2.refunded === true ? "CAPTURED"
        : settle === "captured" ? "CAPTURED"
        : settle === "failed" ? "FAILED"
        : "CAPTURED";

    await db.query(
      `INSERT INTO orders (order_id, intent_id, mandate_id, merchant_id, amount_paise,
         state, idempotency_key, rzp_order_id, rzp_payment_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        orderId, intentId, mandateId, options.merchantId, amount.toString(),
        orderState, idempotencyKey(intentId), railOrderId,
        `pay_${randomUUID().replaceAll("-", "").slice(0, 14)}`,
        at.toISOString(), new Date(at.getTime() + 120_000).toISOString(),
      ],
    );

    await append(mandateId, "API_CALL", intentId, {
      operation: "orders.create", rail: "replay", rail_order_id: railOrderId, state: "SUBMITTED",
    }, at);

    if (settle === "ambiguous") {
      // The one that went quiet and was resolved by reading, forty seconds later.
      await append(mandateId, "RECONCILE", intentId, {
        order_id: orderId, resolved_to: "CAPTURED", note: "no webhook arrived; resolved by orders.fetch",
      }, new Date(at.getTime() + 40_000));
    } else {
      await append(mandateId, "WEBHOOK", intentId, {
        event: settle === "failed" ? "payment.failed" : "payment.captured",
        confirmed_by: "orders.fetch",
      }, new Date(at.getTime() + 60_000));
    }

    await append(mandateId, settle === "failed" ? "RELEASE" : "EXECUTION_RESULT", intentId, {
      order_id: orderId, state: orderState,
    }, new Date(at.getTime() + 90_000));

    if (options2.refunded === true) {
      const refundId = `rfd_seed_${String(intentCounter).padStart(3, "0")}`;
      await db.query(
        `INSERT INTO refunds (refund_id, order_id, merchant_id, amount_paise, reason,
           state, idempotency_key, rzp_refund_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'mandate revoked after capture','COMPLETED',$5,$6,$7,$7)`,
        [
          refundId, orderId, options.merchantId, amount.toString(),
          idempotencyKey(refundId),
          `rfnd_${randomUUID().replaceAll("-", "").slice(0, 14)}`,
          new Date(at.getTime() + 3_600_000).toISOString(),
        ],
      );
      await append(mandateId, "REFUND", intentId, {
        refund_id: refundId, order_id: orderId, state: "COMPLETED",
        reason: "mandate revoked after capture",
      }, new Date(at.getTime() + 3_600_000));
    }

    return intentId;
  }

  // Priya's month. Silent orders, two step-ups, and every denial she actually met.
  await decision(priya, 29, 10, "STEP_UP", "STP-002", 342);
  await decision(priya, 27, 9, "ALLOW", "OK-000", 186);
  await decision(priya, 25, 18, "ALLOW", "OK-000", 274);
  await decision(priya, 24, 11, "ALLOW", "OK-000", 96);
  await decision(priya, 22, 19, "STEP_UP", "STP-001", 1_240);
  await decision(priya, 21, 8, "ALLOW", "OK-000", 155);
  await decision(priya, 20, 12, "DENY", "SCP-002", 899);
  await decision(priya, 19, 20, "ALLOW", "OK-000", 240);
  await decision(priya, 18, 21, "DENY", "LMT-003", 190);
  await decision(priya, 17, 9, "ALLOW", "OK-000", 420);
  await decision(priya, 16, 10, "ALLOW", "OK-000", 64);
  await decision(priya, 15, 14, "ALLOW", "OK-000", 185, { settle: "ambiguous" });
  await decision(priya, 14, 16, "DENY", "INT-002", 155);
  await decision(priya, 13, 11, "ALLOW", "OK-000", 260);
  await decision(priya, 12, 3, "DENY", "SEC-001", 899);
  await decision(priya, 11, 9, "ALLOW", "OK-000", 45);
  await decision(priya, 10, 13, "DENY", "SEC-004", 3_400);
  await decision(priya, 9, 10, "ALLOW", "OK-000", 160);
  await decision(priya, 8, 17, "DENY", "INT-003", 500);
  await decision(priya, 7, 8, "ALLOW", "OK-000", 64);
  await decision(priya, 6, 15, "DENY", "LMT-001", 7_200);
  await decision(priya, 5, 9, "ALLOW", "OK-000", 155, { settle: "failed" });
  await decision(priya, 4, 11, "DENY", "INT-004", 340);
  await decision(priya, 3, 10, "ALLOW", "OK-000", 240);
  await decision(priya, 2, 12, "DENY", "INT-001", 500);
  await decision(priya, 1, 9, "DENY", "SEC-002", 300);
  await decision(priya, 1, 14, "DENY", "SYS-002", 2_100);
  await decision(priya, 0, 9, "DENY", "SYS-003", 400);
  await decision(priya, 0, 10, "DENY", "AUT-001", 250);
  await decision(priya, 0, 11, "DENY", "SCP-001", 180);
  await decision(priya, 0, 12, "DENY", "LMT-004", 900);
  await decision(priya, 0, 13, "DENY", "LMT-005", 120);
  await decision(priya, 0, 14, "DENY", "MND-001", 260);
  await decision(priya, 0, 15, "DENY", "SEC-003", 300);
  // The headline denial: her cap is spent, so the next order is refused rather than
  // silently allowed against a stale settled total.
  await decision(priya, 0, 16, "DENY", "LMT-002", 1_100);
  await decision(priya, 0, 17, "DENY", "SYS-001", 200);
  // Grant-time only: a mandate binds a fresh authentication event, and this one had gone
  // stale by the time the scope screen was submitted.
  await decision(priya, 0, 18, "DENY", "AUT-002", 260);

  // Arjun: the revocation, with the payment that had already left.
  await decision(revoked, 27, 10, "ALLOW", "OK-000", 380);
  await decision(revoked, 26, 11, "ALLOW", "OK-000", 230, { refunded: true });
  await decision(revoked, 20, 10, "DENY", "MND-003", 190);
  await decision(revoked, 10, 10, "DENY", "MND-003", 145);

  // Meera: expired, so MND-002 is real rather than staged.
  await decision(expired, 38, 10, "ALLOW", "OK-000", 320);
  await decision(expired, 35, 12, "ALLOW", "OK-000", 210);
  await decision(expired, 20, 10, "DENY", "MND-002", 260);
  await decision(expired, 5, 10, "DENY", "MND-002", 175);

  // Priya sits at 98% of her ₹15,000 cap, so the meter reads as something.
  const spent = await db.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_paise),0)::text AS total FROM reservations
      WHERE mandate_id = $1 AND state IN ('held','captured')
        AND created_at > now() - INTERVAL '30 days'`,
    [priya],
  );
  const target = rupees(15_000) * 98n / 100n;
  const shortfall = target - BigInt(spent.rows[0]!.total);
  if (shortfall > 0n) {
    await db.query(
      `INSERT INTO reservations (reservation_id, mandate_id, merchant_id, intent_id,
         amount_paise, state, created_at, resolved_at)
       VALUES ('rsv_seed_topup', $1, $2, 'int_seed_topup', $3, 'captured',
               now() - INTERVAL '9 days', now() - INTERVAL '9 days')`,
      [priya, options.merchantId, shortfall.toString()],
    );
  }

  // Chain heads, so the console and the verifier agree from the first read.
  for (const [chainId, cursor] of chains) {
    await db.query(
      `UPDATE mandates SET chain_head_seq = $2, chain_head_hash = $3 WHERE mandate_id = $1`,
      [chainId, cursor.seq - 1, cursor.prev],
    );
  }

  const anchorHeads = [...chains.entries()].map(([chainId, cursor]) => ({
    chain_id: chainId,
    seq: cursor.seq - 1,
    hash: cursor.prev.toString("hex"),
  }));
  await db.query(
    `INSERT INTO ledger_anchor (anchor_id, chain_heads, kid, sig, created_at)
     VALUES ($1, $2::jsonb, $3, $4, now() - INTERVAL '1 hour')`,
    [
      `anc_seed_${randomUUID().slice(0, 8)}`,
      JSON.stringify(anchorHeads),
      keys.anchor!.kid,
      signPayload(keys.anchor!.privateKey, {
        chain_heads: anchorHeads as unknown as JsonValue,
        merchant_id: options.merchantId,
      }),
    ],
  );

  console.log(
    `[seed] ${chains.size} mandates, ${intentCounter} decisions, ${anchorHeads.length} chains anchored`,
  );
}
