import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The merchant's statement of who is approving, carried by the shopper's own browser.
 *
 * A server-to-server bind leaves the kernel unable to connect "the merchant said cust_101"
 * with "this person is now on the consent page". A compromised merchant backend could
 * bind one shopper's id to a request another shopper is about to approve, and the goods
 * would ship to the wrong person while the right one authorised the spending.
 *
 * Passing it through the redirect fixes half of that: the statement travels with the
 * shopper, is signed, and expires. The other half cannot be fixed cryptographically —
 * customer ids belong to the merchant's namespace and are opaque to us, so we can never
 * prove cust_101 is this person. What we can do is show them. The display fields exist
 * for exactly that: they are rendered on the consent screen and never stored, so the one
 * party who can tell whether the address is theirs is given the chance to.
 */

export interface AuthorizationClaims {
  readonly ref: string;
  readonly customerRef: string;
  readonly fulfilmentRef: string;
  /** Rendered so the shopper can check it. Never written to the database. */
  readonly displayName: string;
  readonly displayAddress: string;
  readonly expiresAt: number;
}

export type TokenOutcome =
  | { kind: "VALID"; claims: AuthorizationClaims }
  | { kind: "MALFORMED" }
  | { kind: "BAD_SIGNATURE" }
  | { kind: "EXPIRED" }
  | { kind: "WRONG_REQUEST" };

function b64url(input: Buffer): string {
  return input.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function sign(secret: string, payload: string): string {
  return b64url(createHmac("sha256", secret).update(payload).digest());
}

export function mintAuthorizationToken(
  secret: string,
  claims: Omit<AuthorizationClaims, "expiresAt">,
  ttlMs = 10 * 60 * 1000,
): string {
  const payload = b64url(
    Buffer.from(JSON.stringify({ ...claims, expiresAt: Date.now() + ttlMs }), "utf8"),
  );
  return `${payload}.${sign(secret, payload)}`;
}

/**
 * The signature is checked before anything inside is read, and in constant time. The ref
 * is checked too: a token is a statement about one request, so it cannot be lifted from
 * one consent link and replayed against another.
 */
export function verifyAuthorizationToken(
  secret: string,
  token: string,
  expectedRef: string,
): TokenOutcome {
  const [payload, signature] = token.split(".");
  if (payload === undefined || signature === undefined) return { kind: "MALFORMED" };

  const expected = Buffer.from(sign(secret, payload), "utf8");
  const supplied = Buffer.from(signature, "utf8");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return { kind: "BAD_SIGNATURE" };
  }

  let claims: AuthorizationClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AuthorizationClaims;
  } catch {
    return { kind: "MALFORMED" };
  }

  if (
    typeof claims.ref !== "string" ||
    typeof claims.customerRef !== "string" ||
    typeof claims.fulfilmentRef !== "string" ||
    typeof claims.expiresAt !== "number"
  ) {
    return { kind: "MALFORMED" };
  }

  if (claims.ref !== expectedRef) return { kind: "WRONG_REQUEST" };
  if (Date.now() > claims.expiresAt) return { kind: "EXPIRED" };

  return { kind: "VALID", claims };
}
