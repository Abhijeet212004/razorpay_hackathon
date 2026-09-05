import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { setMerchantContext } from "../../shared/db/merchant-context.js";
import type {
  MerchantConfigUpdate,
  MerchantCredentials,
  MerchantOnboarding,
  MerchantRecord,
  ResolveOutcome,
} from "./merchant.validation.js";

/**
 * The merchant registry: who exists, what they configured, and which credential speaks
 * for them.
 *
 * Resolution is the security-critical operation. An agent presents a key; that key alone
 * decides whose catalogue it sees, whose limits bind it, and whose money is at stake. If
 * a merchant id could be supplied in a request body, an agent would choose its own
 * jurisdiction — so it never is, anywhere.
 */

/** Stored as a hash. A leaked table yields nothing that can be presented as a credential. */
function hash(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

function mintSecret(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

export async function onboard(
  pool: Pool,
  input: MerchantOnboarding,
): Promise<MerchantCredentials & { record: MerchantRecord }> {
  const merchantId = `mch_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const apiKey = mintSecret("ak");
  const fulfilToken = mintSecret("aft");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // The row must be visible to the policy that will govern it, so the context is set to
    // the merchant being created before it is inserted.
    await setMerchantContext(client, merchantId);
    await client.query(
      `INSERT INTO merchants (merchant_id, name, display_name, catalog_url, fulfil_url,
                              authorize_url, public_base_url, api_key_hash, api_key_prefix,
                              fulfil_token_hash, state)
       VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, 'active')`,
      [
        merchantId,
        input.display_name,
        input.catalog_url,
        input.fulfil_url ?? null,
        input.authorize_url ?? null,
        input.public_base_url,
        hash(apiKey),
        apiKey.slice(0, 11),
        hash(fulfilToken),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  return {
    merchantId,
    apiKey,
    fulfilToken,
    record: {
      merchantId,
      displayName: input.display_name,
      catalogUrl: input.catalog_url,
      fulfilUrl: input.fulfil_url ?? null,
      authorizeUrl: input.authorize_url ?? null,
      publicBaseUrl: input.public_base_url,
      state: "active",
    },
  };
}

/**
 * Which merchant does this credential speak for?
 *
 * Goes through a SECURITY DEFINER function because this is the one lookup that cannot be
 * tenant-scoped — it is what decides the tenant. The function returns a single row and
 * two columns, so the privilege it holds is the narrowest that answers the question.
 */
async function resolve(
  pool: Pool,
  fn: "resolve_merchant_by_key" | "resolve_merchant_by_fulfil_token",
  secret: string,
): Promise<ResolveOutcome> {
  if (secret.length === 0) return { kind: "UNKNOWN" };

  const result = await pool.query<{ merchant_id: string; state: string }>(
    `SELECT merchant_id, state FROM ${fn}($1)`,
    [hash(secret)],
  );
  const row = result.rows[0];
  if (row === undefined) return { kind: "UNKNOWN" };
  return row.state === "active"
    ? { kind: "RESOLVED", merchantId: row.merchant_id }
    : { kind: "SUSPENDED", merchantId: row.merchant_id };
}

/**
 * Which merchant does this reference belong to?
 *
 * The same question as above, asked of something that is not a credential. A consent ref,
 * a challenge id and an intent id are random UUIDs owned by exactly one merchant, and the
 * callers holding them are browsers: a shopper granting a mandate, clearing a step up, or
 * paying. They present no key, and asking them to would mean handing a shopper an API
 * credential.
 *
 * So the reference decides the tenant. Knowing one is the capability, the way a receipt
 * link is. These are not hashed, because they are identifiers rather than secrets, and
 * they return nothing but a merchant id.
 */
async function resolveByReference(
  pool: Pool,
  fn:
    | "resolve_merchant_by_consent_ref"
    | "resolve_merchant_by_challenge"
    | "resolve_merchant_by_order_intent"
    | "resolve_merchant_by_mandate"
    | "resolve_active_merchant",
  reference: string,
): Promise<ResolveOutcome> {
  if (reference.length === 0) return { kind: "UNKNOWN" };

  const result = await pool.query<{ merchant_id: string; state: string }>(
    `SELECT merchant_id, state FROM ${fn}($1)`,
    [reference],
  );
  const row = result.rows[0];
  if (row === undefined) return { kind: "UNKNOWN" };
  return row.state === "active"
    ? { kind: "RESOLVED", merchantId: row.merchant_id }
    : { kind: "SUSPENDED", merchantId: row.merchant_id };
}

export const resolveByConsentRef = (pool: Pool, ref: string): Promise<ResolveOutcome> =>
  resolveByReference(pool, "resolve_merchant_by_consent_ref", ref);

export const resolveByChallenge = (pool: Pool, challenge: string): Promise<ResolveOutcome> =>
  resolveByReference(pool, "resolve_merchant_by_challenge", challenge);

export const resolveByOrderIntent = (pool: Pool, intentId: string): Promise<ResolveOutcome> =>
  resolveByReference(pool, "resolve_merchant_by_order_intent", intentId);

export const resolveByMandate = (pool: Pool, mandateId: string): Promise<ResolveOutcome> =>
  resolveByReference(pool, "resolve_merchant_by_mandate", mandateId);

/** Discovery only. A merchant id is not a secret; this says whether it exists and is active. */
export const resolveActiveMerchant = (pool: Pool, merchantId: string): Promise<ResolveOutcome> =>
  resolveByReference(pool, "resolve_active_merchant", merchantId);

export const resolveByApiKey = (pool: Pool, key: string): Promise<ResolveOutcome> =>
  resolve(pool, "resolve_merchant_by_key", key);

export const resolveByFulfilToken = (pool: Pool, token: string): Promise<ResolveOutcome> =>
  resolve(pool, "resolve_merchant_by_fulfil_token", token);

/**
 * The key a merchant's authorisation handoffs are signed with.
 *
 * It is the stored hash of their fulfil token, which both sides can derive: the merchant
 * holds the token and hashes it, the kernel holds the hash already. That keeps the token
 * itself hash-only at rest — nothing here is stored reversibly — while still giving every
 * merchant a distinct signing key.
 *
 * Before this, every handoff was verified against one process-wide secret, so on a hosted
 * deployment one merchant could mint a token binding a customer at another.
 *
 * Returns null for a merchant with no token issued, which is the single-tenant demo case;
 * the caller falls back to hashing the configured token so both sides still agree.
 */
export async function handoffKey(pool: Pool, merchantId: string): Promise<string | null> {
  // Through a definer function: the caller is verifying a handoff on behalf of a shopper
  // who has no tenant context, and merchants is under forced row level security. A plain
  // query here returns nothing and silently falls back to the wrong key.
  const result = await pool.query<{ merchant_handoff_key: Buffer | null }>(
    `SELECT merchant_handoff_key($1)`,
    [merchantId],
  );
  const stored = result.rows[0]?.merchant_handoff_key ?? null;
  return stored === null ? null : stored.toString("hex");
}

/** Reads a merchant's own row, under their own tenant context. */
export async function read(client: PoolClient, merchantId: string): Promise<MerchantRecord | null> {
  const result = await client.query<{
    merchant_id: string;
    display_name: string | null;
    name: string;
    catalog_url: string | null;
    fulfil_url: string | null;
    authorize_url: string | null;
    public_base_url: string | null;
    state: string;
  }>(
    `SELECT merchant_id, display_name, name, catalog_url, fulfil_url, authorize_url,
            public_base_url, state
       FROM merchants WHERE merchant_id = $1`,
    [merchantId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    merchantId: row.merchant_id,
    displayName: row.display_name ?? row.name,
    catalogUrl: row.catalog_url,
    fulfilUrl: row.fulfil_url,
    authorizeUrl: row.authorize_url,
    publicBaseUrl: row.public_base_url,
    state: row.state === "suspended" ? "suspended" : "active",
  };
}

/** Column-level update: a merchant may change its own URLs, never its credentials. */
export async function updateConfig(
  client: PoolClient,
  merchantId: string,
  update: MerchantConfigUpdate,
): Promise<void> {
  await client.query(
    `UPDATE merchants
        SET display_name    = COALESCE($2, display_name),
            catalog_url     = COALESCE($3, catalog_url),
            fulfil_url      = COALESCE($4, fulfil_url),
            authorize_url   = COALESCE($5, authorize_url),
            public_base_url = COALESCE($6, public_base_url)
      WHERE merchant_id = $1`,
    [
      merchantId,
      update.display_name ?? null,
      update.catalog_url ?? null,
      update.fulfil_url ?? null,
      update.authorize_url ?? null,
      update.public_base_url ?? null,
    ],
  );
}

/** Constant-time compare, for anywhere a caller-supplied token is checked directly. */
export function secretMatches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
