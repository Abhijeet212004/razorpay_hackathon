import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import {
  mintAuthorizationToken,
  verifyAuthorizationToken,
} from "../../src/modules/consent/authorization-token.js";

const require = createRequire(import.meta.url);
const sdk = require("../../packages/merchant/index.js");

/**
 * The handoff is signed per merchant.
 *
 * It used to be verified against one process-wide AGENTKIT_FULFIL_TOKEN, so on a hosted
 * deployment any merchant could mint a token binding a customer at any other. The key is
 * now the sha256 of each merchant's own fulfil token: the merchant derives it from the
 * token they hold, the kernel reads the hash it already stores, and neither side ever
 * keeps the token in a recoverable form.
 */
const keyFor = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

const CLAIMS = {
  ref: "creq_1",
  customerRef: "usr_1",
  fulfilmentRef: "adr_1",
  displayName: "A Shopper",
  displayAddress: "12 Example Road",
};

describe("authorisation handoffs are isolated per merchant", () => {
  it("a merchant's own token verifies", () => {
    const key = keyFor("aft_merchant_a");
    const token = mintAuthorizationToken(key, CLAIMS);
    expect(verifyAuthorizationToken(key, token, "creq_1").kind).toBe("VALID");
  });

  it("one merchant cannot mint a token another merchant's key accepts", () => {
    const forged = mintAuthorizationToken(keyFor("aft_merchant_b"), {
      ...CLAIMS,
      customerRef: "usr_victim",
    });
    expect(verifyAuthorizationToken(keyFor("aft_merchant_a"), forged, "creq_1").kind)
      .toBe("BAD_SIGNATURE");
  });

  it("the SDK derives the same key the kernel verifies with", () => {
    const kit = new sdk.AgentKit({ baseUrl: "https://k.example", fulfilToken: "aft_merchant_a" });
    const token = kit.authorizationToken({ requestRef: "creq_1", ...CLAIMS, ref: undefined });

    const outcome = verifyAuthorizationToken(keyFor("aft_merchant_a"), token, "creq_1");
    expect(outcome.kind).toBe("VALID");
    if (outcome.kind === "VALID") {
      expect(outcome.claims.customerRef).toBe("usr_1");
      expect(outcome.claims.displayAddress).toBe("12 Example Road");
    }
  });

  it("a token signed with the raw token rather than its hash is refused", () => {
    // The old scheme. A merchant still on it fails closed rather than silently working.
    const oldStyle = mintAuthorizationToken("aft_merchant_a", CLAIMS);
    expect(verifyAuthorizationToken(keyFor("aft_merchant_a"), oldStyle, "creq_1").kind)
      .toBe("BAD_SIGNATURE");
  });

  it("a token is still bound to one consent request", () => {
    const key = keyFor("aft_merchant_a");
    const token = mintAuthorizationToken(key, CLAIMS);
    expect(verifyAuthorizationToken(key, token, "creq_other").kind).toBe("WRONG_REQUEST");
  });
});
