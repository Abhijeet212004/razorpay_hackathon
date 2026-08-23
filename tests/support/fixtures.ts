import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { generateKeyPair, signPayload } from "../../src/shared/crypto/ed25519.js";
import type { Paise } from "../../src/shared/money.js";
import {
  intentSigningPayload,
  type Intent,
  type SignedIntent,
} from "../../src/modules/authorization/authorization.validation.js";
import {
  quoteSigningPayload,
  type Quote,
  type SignedQuote,
} from "../../src/modules/quote/quote.validation.js";

/**
 * Fixtures write through the superuser pool, which bypasses row level security. Seeding
 * is not a runtime code path, and making it fight RLS would only test the fixtures.
 * Every assertion reads back through a real service role.
 */

export const MERCHANT_A = "mch_sharma_kirana";
export const MERCHANT_B = "mch_other_store";

/** The operations chain locks this row, and the catalog hangs off it. */
export async function seedMerchant(db: Pool, merchantId = MERCHANT_A, name = "Sharma Kirana"): Promise<string> {
  await db.query(
    `INSERT INTO merchants (merchant_id, name) VALUES ($1, $2)
     ON CONFLICT (merchant_id) DO NOTHING`,
    [merchantId, name],
  );
  return merchantId;
}

export async function seedCatalogItem(
  db: Pool,
  item: { merchantId?: string; sku: string; name?: string; category: string; pricePaise: Paise },
): Promise<void> {
  await db.query(
    `INSERT INTO catalog_items (merchant_id, sku, name, category, price_paise)
     VALUES ($1, $2, $3, $4, $5)`,
    [item.merchantId ?? MERCHANT_A, item.sku, item.name ?? item.sku, item.category,
     item.pricePaise.toString()],
  );
}

export interface SeededKey {
  kid: string;
  publicKey: Buffer;
  privateKey: Buffer;
}

export async function seedSigningKey(
  db: Pool,
  purpose: "mandate" | "quote" | "catalog" | "anchor",
): Promise<SeededKey> {
  const { publicKey, privateKey } = generateKeyPair();
  const kid = `kid_${purpose}_${randomUUID().slice(0, 8)}`;
  await db.query(
    `INSERT INTO signing_keys (kid, purpose, state, public_key, private_key)
     VALUES ($1, $2, 'active', $3, $4)`,
    [kid, purpose, publicKey, privateKey],
  );
  return { kid, publicKey, privateKey };
}

export interface SeededAgent {
  agentId: string;
  publicKey: Buffer;
  privateKey: Buffer;
}

export async function seedAgent(db: Pool, name = "ShopBuddy"): Promise<SeededAgent> {
  const { publicKey, privateKey } = generateKeyPair();
  const agentId = `agt_${randomUUID().slice(0, 8)}`;
  await db.query(
    `INSERT INTO agents (agent_id, name, public_key, attestation)
     VALUES ($1, $2, $3, 'self_registered_v1')`,
    [agentId, name, publicKey],
  );
  return { agentId, publicKey, privateKey };
}

/** A key pair that is deliberately not registered. */
export function unregisteredAgent(): SeededAgent {
  const { publicKey, privateKey } = generateKeyPair();
  return { agentId: `agt_unregistered_${randomUUID().slice(0, 8)}`, publicKey, privateKey };
}

export async function seedSubject(db: Pool): Promise<{ pseudonym: string; authEventId: string }> {
  const pseudonym = `psu_${randomUUID().slice(0, 8)}`;
  const authEventId = `aev_${randomUUID().slice(0, 8)}`;
  await db.query(
    `INSERT INTO pseudonym_map (subject_pseudonym, person_ref) VALUES ($1, $2)`,
    [pseudonym, `+9199${randomBytes(4).readUInt32BE(0) % 100000000}`],
  );
  await db.query(
    `INSERT INTO auth_events (auth_event_id, subject_pseudonym, method, max_age_seconds)
     VALUES ($1, $2, 'sms_otp', 300)`,
    [authEventId, pseudonym],
  );
  return { pseudonym, authEventId };
}

export interface SeedMandateOptions {
  merchantId?: string;
  agentId: string;
  authEventId: string;
  pseudonym: string;
  kid: string;
  perTransactionPaise?: Paise;
  cumulativePaise?: Paise;
  cumulativeWindow?: string;
  velocityPerHour?: number;
  silentThresholdPaise?: Paise;
  allowedMerchants?: string[];
  allowedCategories?: string[];
  state?: "live" | "revoked" | "expired";
  notAfter?: Date;
}

export async function seedMandate(db: Pool, options: SeedMandateOptions): Promise<string> {
  const mandateId = `mnd_${randomUUID().slice(0, 8)}`;
  const merchantId = options.merchantId ?? MERCHANT_A;
  const state = options.state ?? "live";
  const now = new Date();
  await db.query(
    `INSERT INTO mandates (
       mandate_id, merchant_id, subject_pseudonym, agent_id, auth_event_id,
       per_transaction_paise, cumulative_paise, cumulative_window, velocity_per_hour,
       silent_threshold_paise, scope, state, not_before, not_after, revoked_at,
       chain_id, kid, signature
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8::interval, $9,
       $10, $11::jsonb, $12, $13, $14, $15,
       $1, $16, $17
     )`,
    [
      mandateId,
      merchantId,
      options.pseudonym,
      options.agentId,
      options.authEventId,
      (options.perTransactionPaise ?? 500_000n).toString(),
      (options.cumulativePaise ?? 1_500_000n).toString(),
      options.cumulativeWindow ?? "30 days",
      options.velocityPerHour ?? 3,
      (options.silentThresholdPaise ?? 50_000n).toString(),
      JSON.stringify({
        merchants: options.allowedMerchants ?? [merchantId],
        categories: options.allowedCategories ?? ["groceries", "household"],
        currency: "INR",
      }),
      state,
      new Date(now.getTime() - 86_400_000).toISOString(),
      (options.notAfter ?? new Date(now.getTime() + 30 * 86_400_000)).toISOString(),
      state === "revoked" ? now.toISOString() : null,
      options.kid,
      Buffer.from("fixture-signature"),
    ],
  );
  return mandateId;
}

/** A prior settled purchase, giving the mandate history and consuming cap. */
export async function seedCapturedReservation(
  db: Pool,
  opts: { mandateId: string; merchantId?: string; amountPaise: Paise; ageMs?: number },
): Promise<string> {
  const reservationId = `rsv_${randomUUID().slice(0, 8)}`;
  const createdAt = new Date(Date.now() - (opts.ageMs ?? 86_400_000));
  await db.query(
    `INSERT INTO reservations (
       reservation_id, mandate_id, merchant_id, intent_id, amount_paise,
       state, created_at, resolved_at
     ) VALUES ($1, $2, $3, $4, $5, 'captured', $6, $6)`,
    [
      reservationId,
      opts.mandateId,
      opts.merchantId ?? MERCHANT_A,
      `int_prior_${randomUUID().slice(0, 8)}`,
      opts.amountPaise.toString(),
      createdAt.toISOString(),
    ],
  );
  return reservationId;
}

export interface IssueQuoteOptions {
  mandateId: string;
  merchantId?: string;
  amountPaise: Paise;
  categories?: string[];
  key: SeededKey;
  ttlMs?: number;
  basketHash?: string;
}

export async function issueQuote(db: Pool, options: IssueQuoteOptions): Promise<SignedQuote> {
  const now = new Date();
  const quote: Quote = {
    quote_id: `qte_${randomUUID().slice(0, 8)}`,
    mandate_id: options.mandateId,
    merchant_id: options.merchantId ?? MERCHANT_A,
    basket_hash: options.basketHash ?? randomBytes(32).toString("hex"),
    amount_paise: options.amountPaise,
    categories: options.categories ?? ["groceries"],
    nonce: randomBytes(16).toString("hex"),
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + (options.ttlMs ?? 600_000)).toISOString(),
  };
  const signature = signPayload(options.key.privateKey, quoteSigningPayload(quote));

  await db.query(
    `INSERT INTO quotes (
       quote_id, mandate_id, merchant_id, basket_hash, amount_paise, categories,
       nonce, issued_at, expires_at, kid, signature
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      quote.quote_id,
      quote.mandate_id,
      quote.merchant_id,
      Buffer.from(quote.basket_hash, "hex"),
      quote.amount_paise.toString(),
      quote.categories,
      quote.nonce,
      quote.issued_at,
      quote.expires_at,
      options.key.kid,
      signature,
    ],
  );

  return { quote, kid: options.key.kid, signature: signature.toString("hex") };
}

export interface MakeIntentOptions {
  agent: SeededAgent;
  mandateId: string;
  quote: SignedQuote;
  /** Defaults to the quote amount. Set it differently to attack the amount binding. */
  amountPaise?: Paise;
  merchantId?: string;
  rationale?: string;
  nonce?: string;
  ttlMs?: number;
  tamperSignature?: boolean;
}

export function makeSignedIntent(options: MakeIntentOptions): SignedIntent {
  const now = new Date();
  const intent: Intent = {
    intent_id: `int_${randomUUID()}`,
    type: "purchase",
    mandate_id: options.mandateId,
    quote_id: options.quote.quote.quote_id,
    merchant_id: options.merchantId ?? options.quote.quote.merchant_id,
    amount_paise: options.amountPaise ?? options.quote.quote.amount_paise,
    basket_hash: options.quote.quote.basket_hash,
    rationale: options.rationale ?? "reordering the usual weekly basket",
    nonce: options.nonce ?? randomBytes(16).toString("hex"),
    expires_at: new Date(now.getTime() + (options.ttlMs ?? 120_000)).toISOString(),
  };

  const signature = signPayload(options.agent.privateKey, intentSigningPayload(intent));
  if (options.tamperSignature) signature.writeUInt8(signature.readUInt8(0) ^ 0xff, 0);

  return { intent, agent_id: options.agent.agentId, signature: signature.toString("hex") };
}
