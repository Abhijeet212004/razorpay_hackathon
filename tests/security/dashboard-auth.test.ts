import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeSession,
  cookieValue,
  createUser,
  emailTaken,
  hashPassword,
  openSession,
  readSession,
  sessionCookie,
  signIn,
  verifyPassword,
} from "../../src/modules/dashboard/dashboard.auth.js";
import { onboard } from "../../src/modules/merchant/merchant.repository.js";
import { ROLES } from "../../src/shared/db/roles.js";
import { startTestDatabase, type TestDatabase } from "../support/postgres.js";

/**
 * Who may see and rotate a merchant's live API keys.
 *
 * The dashboard is where credentials are shown, so a session here is worth as much as the
 * keys behind it — which is why sessions are revocable server-side rather than signed
 * into a cookie nobody can take back.
 */
describe("dashboard accounts", () => {
  let db: TestDatabase;
  let merchantId: string;

  beforeAll(async () => {
    db = await startTestDatabase();
    const m = await onboard(db.as(ROLES.kernel), {
      display_name: "Alpha", catalog_url: "https://a.test/p", public_base_url: "https://a.test",
    });
    merchantId = m.merchantId;
  });
  afterAll(async () => { await db?.stop(); });

  it("never stores a password it could read back", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(stored).not.toContain("correct horse");
    expect(stored.startsWith("scrypt:")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("wrong", stored)).toBe(false);
  });

  it("salts, so two people with the same password do not share a hash", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
  });

  it("signs a person in and refuses a wrong password", async () => {
    const pool = db.as(ROLES.kernel);
    await createUser(pool, { email: "Owner@Alpha.test", password: "s3cret-passphrase", merchantId });

    expect(await signIn(pool, "owner@alpha.test", "s3cret-passphrase")).toMatchObject({
      email: "owner@alpha.test", merchantId,
    });
    expect(await signIn(pool, "owner@alpha.test", "not-it")).toBeNull();
    expect(await signIn(pool, "nobody@alpha.test", "s3cret-passphrase")).toBeNull();
  });

  it("folds case, so one address cannot become two accounts", async () => {
    expect(await emailTaken(db.as(ROLES.kernel), "OWNER@ALPHA.TEST")).toBe(true);
  });

  it("opens a session that resolves back to its merchant", async () => {
    const pool = db.as(ROLES.kernel);
    const user = (await signIn(pool, "owner@alpha.test", "s3cret-passphrase"))!;
    const sid = await openSession(pool, user);

    expect(await readSession(pool, sid)).toMatchObject({ merchantId, email: "owner@alpha.test" });
  });

  it("revokes a session immediately", async () => {
    const pool = db.as(ROLES.kernel);
    const user = (await signIn(pool, "owner@alpha.test", "s3cret-passphrase"))!;
    const sid = await openSession(pool, user);
    await closeSession(pool, sid);
    expect(await readSession(pool, sid)).toBeNull();
  });

  it("treats a forged or absent session as nobody", async () => {
    const pool = db.as(ROLES.kernel);
    for (const junk of [undefined, "", "not-a-session", "a".repeat(43)]) {
      expect(await readSession(pool, junk)).toBeNull();
    }
  });

  it("sets a cookie script cannot read and a cross-site form cannot ride", () => {
    const cookie = sessionCookie("abc123", true);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(sessionCookie("abc123", false)).not.toContain("Secure");
  });

  it("reads its own cookie out of a header without a parser", () => {
    expect(cookieValue("other=1; agentkit_dash=xyz; more=2", "agentkit_dash")).toBe("xyz");
    expect(cookieValue("other=1", "agentkit_dash")).toBeUndefined();
    expect(cookieValue(undefined, "agentkit_dash")).toBeUndefined();
  });
});
