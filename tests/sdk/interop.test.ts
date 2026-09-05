import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { canonicalBytes } from "../../src/shared/crypto/jcs.js";
import { verifyPayload } from "../../src/shared/crypto/ed25519.js";
import { intentSigningPayload } from "../../src/modules/authorization/authorization.validation.js";
import { quoteSigningPayload } from "../../src/modules/quote/quote.validation.js";

const require = createRequire(import.meta.url);
// Loaded through require: this is the published CommonJS package, exercised exactly as a
// merchant would consume it rather than through the TypeScript sources.
const sdk = require("../../packages/merchant/index.js");

/**
 * The published SDK and the kernel must agree on bytes.
 *
 * Everything else in @agentkit/merchant is convenience. This is the part that fails
 * silently if it drifts, because a canonicalisation mismatch is indistinguishable from a
 * forged signature: the kernel answers INT-001 either way, and a merchant integrating for
 * the first time has no way to tell which one they are looking at.
 */
describe("@agentkit/merchant interoperates with the kernel", () => {
  it("canonicalises identically", () => {
    const samples = [
      { b: 2, a: 1 },
      { z: [3, 1, 2], y: "x" },
      { nested: { d: null, c: true }, arr: [{ k: 1 }] },
      { "unicodé": "vaélue", empty: {} },
      { s: "quote\"and\\slash", t: true },
    ];
    for (const sample of samples) {
      expect(sdk.canonicalise(sample)).toBe(canonicalBytes(sample as never).toString("utf8"));
    }
  });

  it("builds the same intent signing payload as the kernel", () => {
    const intent = {
      intent_id: "int_1",
      type: "purchase" as const,
      mandate_id: "mnd_1",
      quote_id: "qte_1",
      merchant_id: "mch_1",
      amount_paise: 42_000n,
      basket_hash: "abc",
      rationale: "weekly staples",
      nonce: "ff00",
      expires_at: "2030-01-01T00:00:00.000Z",
    };

    expect(sdk.canonicalise(sdk.intentSigningPayload({ ...intent, amount_paise: "42000" })))
      .toBe(canonicalBytes(intentSigningPayload(intent as never)).toString("utf8"));
  });

  it("builds the same quote signing payload as the kernel", () => {
    const quote = {
      quote_id: "qte_1",
      mandate_id: "mnd_1",
      merchant_id: "mch_1",
      amount_paise: 42_000n,
      basket_hash: "abc",
      categories: ["household", "groceries"],
      issued_at: "2030-01-01T00:00:00.000Z",
      expires_at: "2030-01-01T00:05:00.000Z",
      nonce: "ff00",
    };

    expect(sdk.canonicalise(sdk.quoteSigningPayload({ ...quote, amount_paise: "42000" })))
      .toBe(canonicalBytes(quoteSigningPayload(quote as never)).toString("utf8"));
  });

  it("produces a signature the kernel accepts", () => {
    const keys = sdk.generateKeyPair();
    const intent = {
      intent_id: "int_1",
      type: "purchase" as const,
      mandate_id: "mnd_1",
      quote_id: "qte_1",
      merchant_id: "mch_1",
      amount_paise: 42_000n,
      basket_hash: "abc",
      rationale: "weekly staples",
      nonce: "ff00",
      expires_at: "2030-01-01T00:00:00.000Z",
    };

    // Signed by the SDK, verified through the kernel's own payload builder.
    const signature = sdk.signPayload(
      keys.privateKey,
      sdk.intentSigningPayload({ ...intent, amount_paise: "42000" }),
    );

    expect(verifyPayload(keys.publicKey, intentSigningPayload(intent as never), signature)).toBe(true);
  });

  it("rejects a signature over a different amount", () => {
    const keys = sdk.generateKeyPair();
    const base = {
      intent_id: "int_1",
      type: "purchase" as const,
      mandate_id: "mnd_1",
      quote_id: "qte_1",
      merchant_id: "mch_1",
      basket_hash: "abc",
      rationale: "",
      nonce: "ff00",
      expires_at: "2030-01-01T00:00:00.000Z",
    };

    const signature = sdk.signPayload(
      keys.privateKey,
      sdk.intentSigningPayload({ ...base, amount_paise: "42000" }),
    );

    expect(verifyPayload(
      keys.publicKey,
      intentSigningPayload({ ...base, amount_paise: 1n } as never),
      signature,
    )).toBe(false);
  });
});
