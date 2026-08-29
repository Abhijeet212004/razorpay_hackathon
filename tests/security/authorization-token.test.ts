import { describe, expect, it } from "vitest";
import {
  mintAuthorizationToken,
  verifyAuthorizationToken,
} from "../../src/modules/consent/authorization-token.js";

/**
 * The merchant's claim about who is approving, carried by the shopper's browser.
 *
 * It cannot prove the customer id is really this person — that namespace is the
 * merchant's. It can stop the claim being forged, reused against another request, or
 * replayed later, and it puts the claim in front of the only party able to judge it.
 */
describe("the authorization token", () => {
  const SECRET = "shared-with-the-merchant";
  const claims = {
    ref: "creq_abc",
    customerRef: "cust_101",
    fulfilmentRef: "addr_home",
    displayName: "Abhijeet",
    displayAddress: "12 MG Road, Pune 411001",
  };

  it("round-trips a claim the merchant signed", () => {
    const token = mintAuthorizationToken(SECRET, claims);
    const outcome = verifyAuthorizationToken(SECRET, token, "creq_abc");
    expect(outcome.kind).toBe("VALID");
    if (outcome.kind === "VALID") {
      expect(outcome.claims.customerRef).toBe("cust_101");
      expect(outcome.claims.displayAddress).toBe("12 MG Road, Pune 411001");
    }
  });

  it("refuses a token signed with another secret", () => {
    const forged = mintAuthorizationToken("not-the-secret", claims);
    expect(verifyAuthorizationToken(SECRET, forged, "creq_abc").kind).toBe("BAD_SIGNATURE");
  });

  it("refuses a token whose claims were edited", () => {
    const token = mintAuthorizationToken(SECRET, claims);
    const [payload, signature] = token.split(".");
    const tampered = Buffer.from(
      JSON.stringify({ ...claims, customerRef: "cust_999", expiresAt: Date.now() + 60_000 }),
      "utf8",
    ).toString("base64url");
    expect(payload).not.toBe(tampered);
    expect(verifyAuthorizationToken(SECRET, `${tampered}.${signature}`, "creq_abc").kind)
      .toBe("BAD_SIGNATURE");
  });

  it("refuses a token lifted onto a different consent request", () => {
    const token = mintAuthorizationToken(SECRET, claims);
    expect(verifyAuthorizationToken(SECRET, token, "creq_someone_else").kind)
      .toBe("WRONG_REQUEST");
  });

  it("refuses one that has expired", () => {
    const token = mintAuthorizationToken(SECRET, claims, -1);
    expect(verifyAuthorizationToken(SECRET, token, "creq_abc").kind).toBe("EXPIRED");
  });

  it("refuses rubbish without throwing", () => {
    for (const junk of ["", "no-dot", "a.b", "....", "%%%.%%%"]) {
      expect(["MALFORMED", "BAD_SIGNATURE"]).toContain(
        verifyAuthorizationToken(SECRET, junk, "creq_abc").kind,
      );
    }
  });
});
