import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Pool } from "pg";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * Dashboard accounts and sessions.
 *
 * Passwords go through scrypt with a per-user salt, so a stolen table cannot be reversed
 * with a rainbow table and each guess costs real memory and time. Sessions are stored
 * rather than signed into a cookie: this dashboard shows and rotates live API keys, so
 * being able to revoke a session the moment someone asks is worth a database read.
 */

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SCRYPT_KEYLEN = 64;

async function derive(password: string, salt: Buffer): Promise<Buffer> {
  return scrypt(password, salt, SCRYPT_KEYLEN);
}

/** salt:hash, both hex. Self-describing, so a future cost change can be detected. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt:${salt.toString("hex")}:${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split(":");
  if (scheme !== "scrypt" || saltHex === undefined || keyHex === undefined) return false;

  const expected = Buffer.from(keyHex, "hex");
  const actual = await derive(password, Buffer.from(saltHex, "hex"));
  // Constant time, so a wrong password cannot be narrowed down by how long it took.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface DashboardUser {
  readonly userId: string;
  readonly email: string;
  readonly merchantId: string;
  readonly displayName: string | null;
}

export async function createUser(
  pool: Pool,
  input: { email: string; password: string; merchantId: string; displayName?: string },
): Promise<DashboardUser> {
  const userId = `usr_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  await pool.query(
    `INSERT INTO dashboard_users (user_id, email, merchant_id, password_hash, display_name)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      userId,
      input.email.trim().toLowerCase(),
      input.merchantId,
      await hashPassword(input.password),
      input.displayName ?? null,
    ],
  );
  return {
    userId,
    email: input.email.trim().toLowerCase(),
    merchantId: input.merchantId,
    displayName: input.displayName ?? null,
  };
}

export async function emailTaken(pool: Pool, email: string): Promise<boolean> {
  const found = await pool.query(`SELECT 1 FROM dashboard_users WHERE lower(email) = lower($1)`, [
    email.trim(),
  ]);
  return (found.rowCount ?? 0) > 0;
}

/**
 * A failed sign-in says nothing about which half was wrong, and does the same work either
 * way — an unknown address still pays for one scrypt, so timing cannot enumerate accounts.
 */
const DUMMY_HASH = "scrypt:" + "00".repeat(16) + ":" + "00".repeat(SCRYPT_KEYLEN);

export async function signIn(
  pool: Pool,
  email: string,
  password: string,
): Promise<DashboardUser | null> {
  const found = await pool.query<{
    user_id: string;
    email: string;
    merchant_id: string;
    display_name: string | null;
    password_hash: string;
  }>(
    `SELECT user_id, email, merchant_id, display_name, password_hash
       FROM dashboard_users WHERE lower(email) = lower($1)`,
    [email.trim()],
  );

  const row = found.rows[0];
  const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
  if (row === undefined || !ok) return null;

  await pool.query(`UPDATE dashboard_users SET last_seen_at = now() WHERE user_id = $1`, [
    row.user_id,
  ]);
  return {
    userId: row.user_id,
    email: row.email,
    merchantId: row.merchant_id,
    displayName: row.display_name,
  };
}

export async function openSession(pool: Pool, user: DashboardUser): Promise<string> {
  const sessionId = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO dashboard_sessions (session_id, user_id, merchant_id, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' milliseconds')::interval)`,
    [sessionId, user.userId, user.merchantId, String(SESSION_TTL_MS)],
  );
  return sessionId;
}

export async function readSession(
  pool: Pool,
  sessionId: string | undefined,
): Promise<DashboardUser | null> {
  if (sessionId === undefined || sessionId.length === 0) return null;
  const found = await pool.query<{
    user_id: string;
    email: string;
    merchant_id: string;
    display_name: string | null;
  }>(
    `SELECT u.user_id, u.email, s.merchant_id, u.display_name
       FROM dashboard_sessions s
       JOIN dashboard_users u ON u.user_id = s.user_id
      WHERE s.session_id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sessionId],
  );
  const row = found.rows[0];
  if (row === undefined) return null;
  return {
    userId: row.user_id,
    email: row.email,
    merchantId: row.merchant_id,
    displayName: row.display_name,
  };
}

export async function closeSession(pool: Pool, sessionId: string | undefined): Promise<void> {
  if (sessionId === undefined) return;
  await pool.query(
    `UPDATE dashboard_sessions SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL`,
    [sessionId],
  );
}

/** HttpOnly so script cannot read it; SameSite=Lax so a cross-site form cannot ride it. */
export function sessionCookie(sessionId: string, secure: boolean): string {
  const flags = ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${SESSION_TTL_MS / 1000}`];
  if (secure) flags.push("Secure");
  return `agentkit_dash=${sessionId}; ${flags.join("; ")}`;
}

export function clearedCookie(): string {
  return "agentkit_dash=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
}

export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
}
