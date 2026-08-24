import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { sha256 } from "../../shared/crypto/hash.js";
import { setMerchantContext } from "../../shared/db/merchant-context.js";
import { recordAuthEvent } from "../identity/identity.service.js";
import { issue } from "../mandate/mandate.service.js";
import type { ConsentRequestView, RequestConsentInput } from "./consent.validation.js";

/**
 * The grant flow. It is the only time the user touches merchant property, and every value
 * the screen shows is read from server-held state — never from anything the agent sent
 * with the request.
 *
 * The OTP is stored hashed and compared in constant time. It is a weak factor either way:
 * it makes the binding real, it is not strong authentication.
 */

export interface ConsentOptions {
  readonly merchantId: string;
  readonly merchantName: string;
  readonly otpTtlMs: number;
  /** Shows the code on screen instead of sending it. Demo numbers only. */
  readonly demoMode: boolean;
}

const LOCK_OPTIONS = {
  lockTimeoutMs: 3_000,
  statementTimeoutMs: 5_000,
  retryAttempts: 3,
  retryBackoffMs: [10, 40, 160],
} as const;

function maskContact(contact: string): string {
  return contact.length <= 4 ? "••••" : `••••••${contact.slice(-4)}`;
}

export async function requestConsent(
  pool: Pool,
  options: ConsentOptions,
  input: RequestConsentInput,
): Promise<{ requestRef: string }> {
  const requestRef = `creq_${randomUUID()}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setMerchantContext(client, options.merchantId);
    await client.query(
      `INSERT INTO consent_requests (request_ref, merchant_id, agent_id, requested_scope,
         contact, state)
       VALUES ($1, $2, $3, $4::jsonb, $5, 'pending')`,
      [
        requestRef,
        options.merchantId,
        input.agent_id,
        JSON.stringify({ scope: input.requested_scope, limits: input.limits }),
        input.contact,
      ],
    );
    await client.query("COMMIT");
    // A reference, never a grant. Nothing is authorised until a human finishes the flow.
    return { requestRef };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function readConsentRequest(
  pool: Pool,
  options: ConsentOptions,
  requestRef: string,
): Promise<ConsentRequestView | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setMerchantContext(client, options.merchantId);
    const result = await client.query<{
      request_ref: string;
      state: string;
      contact: string;
      requested_scope: {
        scope: { categories: string[] };
        limits: {
          per_transaction_paise: string;
          cumulative_paise: string;
          silent_threshold_paise: string;
          velocity_per_hour: number;
        };
      };
      agent_name: string;
    }>(
      `SELECT c.request_ref, c.state, c.contact, c.requested_scope, a.name AS agent_name
         FROM consent_requests c JOIN agents a ON a.agent_id = c.agent_id
        WHERE c.request_ref = $1`,
      [requestRef],
    );
    await client.query("COMMIT");

    const row = result.rows[0];
    if (row === undefined) return null;

    return {
      requestRef: row.request_ref,
      agentName: row.agent_name,
      merchantName: options.merchantName,
      state: row.state,
      categories: row.requested_scope.scope.categories,
      perTransactionPaise: BigInt(row.requested_scope.limits.per_transaction_paise),
      cumulativePaise: BigInt(row.requested_scope.limits.cumulative_paise),
      silentThresholdPaise: BigInt(row.requested_scope.limits.silent_threshold_paise),
      velocityPerHour: row.requested_scope.limits.velocity_per_hour,
      contactMasked: maskContact(row.contact),
    };
  } finally {
    client.release();
  }
}

export async function sendOtp(
  pool: Pool,
  options: ConsentOptions,
  requestRef: string,
): Promise<{ code?: string }> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setMerchantContext(client, options.merchantId);
    await client.query(
      `UPDATE consent_requests
          SET state = 'otp_sent', otp_hash = $2, otp_expires_at = $3, otp_attempts = 0
        WHERE request_ref = $1 AND state IN ('pending', 'otp_sent')`,
      [
        requestRef,
        sha256(Buffer.from(`${requestRef}:${code}`, "utf8")),
        new Date(Date.now() + options.otpTtlMs).toISOString(),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  // In demo mode the code comes back so a reviewer with no phone can complete the flow.
  return options.demoMode ? { code } : {};
}

export type GrantOutcome =
  | { readonly kind: "GRANTED"; readonly mandateId: string }
  | { readonly kind: "WRONG_CODE"; readonly attemptsLeft: number }
  | { readonly kind: "EXPIRED" }
  | { readonly kind: "NOT_FOUND" };

export async function verifyAndGrant(
  pool: Pool,
  options: ConsentOptions,
  requestRef: string,
  code: string,
): Promise<GrantOutcome> {
  const client = await pool.connect();
  let pending: {
    agentId: string;
    contact: string;
    scope: { merchants: string[]; categories: string[]; currency: "INR" };
    limits: {
      per_transaction_paise: string;
      cumulative_paise: string;
      silent_threshold_paise: string;
      velocity_per_hour: number;
    };
  };

  try {
    await client.query("BEGIN");
    await setMerchantContext(client, options.merchantId);

    const result = await client.query<{
      agent_id: string;
      contact: string;
      state: string;
      otp_hash: Buffer | null;
      otp_expires_at: Date | null;
      otp_attempts: number;
      requested_scope: { scope: never; limits: never };
    }>(
      `SELECT agent_id, contact, state, otp_hash, otp_expires_at, otp_attempts, requested_scope
         FROM consent_requests WHERE request_ref = $1 FOR UPDATE`,
      [requestRef],
    );

    const row = result.rows[0];
    if (row === undefined || row.otp_hash === null || row.otp_expires_at === null) {
      await client.query("ROLLBACK");
      return { kind: "NOT_FOUND" };
    }
    if (row.state !== "otp_sent" || new Date() >= row.otp_expires_at || row.otp_attempts >= 5) {
      await client.query(
        `UPDATE consent_requests SET state = 'expired', resolved_at = now()
          WHERE request_ref = $1`,
        [requestRef],
      );
      await client.query("COMMIT");
      return { kind: "EXPIRED" };
    }

    const supplied = sha256(Buffer.from(`${requestRef}:${code}`, "utf8"));
    if (!timingSafeEqual(supplied, row.otp_hash)) {
      const attempts = row.otp_attempts + 1;
      await client.query(
        `UPDATE consent_requests SET otp_attempts = $2 WHERE request_ref = $1`,
        [requestRef, attempts],
      );
      await client.query("COMMIT");
      return { kind: "WRONG_CODE", attemptsLeft: 5 - attempts };
    }

    pending = {
      agentId: row.agent_id,
      contact: row.contact,
      scope: (row.requested_scope as unknown as { scope: typeof pending.scope }).scope,
      limits: (row.requested_scope as unknown as { limits: typeof pending.limits }).limits,
    };
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  // INV-13: the verified OTP becomes an auth event, and the mandate binds it. Ambient
  // session state is never consent — what the mandate points at is this verification.
  const pseudonym = `psu_${randomUUID().slice(0, 12)}`;
  const store = await pool.connect();
  try {
    await store.query(`INSERT INTO pseudonym_map (subject_pseudonym, person_ref) VALUES ($1, $2)`, [
      pseudonym,
      pending.contact,
    ]);
  } finally {
    store.release();
  }

  const { authEventId } = await recordAuthEvent(pool, {
    subject_pseudonym: pseudonym,
    method: "sms_otp",
    max_age_seconds: 300,
  });

  const now = new Date();
  const { mandateId } = await issue(
    pool,
    { merchantId: options.merchantId, ...LOCK_OPTIONS },
    {
      merchant_id: options.merchantId,
      subject_pseudonym: pseudonym,
      agent_id: pending.agentId,
      auth_event_id: authEventId,
      scope: pending.scope,
      limits: {
        per_transaction_paise: BigInt(pending.limits.per_transaction_paise),
        cumulative_paise: BigInt(pending.limits.cumulative_paise),
        cumulative_window: "30 days",
        velocity_per_hour: pending.limits.velocity_per_hour,
        silent_threshold_paise: BigInt(pending.limits.silent_threshold_paise),
      },
      not_before: now.toISOString(),
      not_after: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
    },
  );

  const finish = await pool.connect();
  try {
    await finish.query("BEGIN");
    await setMerchantContext(finish, options.merchantId);
    await finish.query(
      `UPDATE consent_requests SET state = 'granted', mandate_id = $2, resolved_at = now()
        WHERE request_ref = $1`,
      [requestRef, mandateId],
    );
    await finish.query("COMMIT");
  } finally {
    finish.release();
  }

  return { kind: "GRANTED", mandateId };
}
