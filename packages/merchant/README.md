# @agentkit/merchant

Server-side SDK for integrating an AgentKit trust kernel.

An agent can hold a signing key without ever holding a payment credential. This package
gives your backend the three things that are genuinely hard to get right on your own:
canonical bytes, Ed25519 intent signing, and the separation between the credential you
give an agent and the one you never do.

```
npm install @agentkit/merchant
```

Requires Node 18 or newer.

## Why not just call the HTTP API

You can, and the API is documented. But three details are unforgiving, and all three fail
the same way: the kernel answers `INT-001`, which means *this signature does not match
this payload*, and deliberately says no more than that. A signature check that explained
itself would be an oracle for forging one.

1. **Canonical JSON.** Signatures cover RFC 8785 bytes. Key order, escaping and number
   formatting all have to match the kernel exactly.
2. **Money is a string.** `amount_paise` is signed as a decimal string, never a JSON
   number. Paise exceed float precision long before they exceed a realistic basket, and a
   float that rounds is a price that silently changed.
3. **The signing payload is a closed set.** Ten named fields for an intent, nine for a
   quote. An extra key changes the bytes; so does a missing one.

This package is tested against the kernel's own implementation, byte for byte, so these
stay in step.

## Quick start

```js
const { AgentKit } = require("@agentkit/merchant");

const kit = new AgentKit({
  baseUrl: "https://kernel.yourshop.in",
  apiKey: process.env.AGENTKIT_API_KEY,
});

const keys = AgentKit.generateKeyPair();
const { agentId } = await kit.registerAgent({ name: "Shop Assistant", publicKey: keys.publicKey });

// Persist agentId and keys.privateKey. See "Identity is not a cache" below.

const signedQuote = await kit.quote({ mandateId, items: [{ sku: "rice-5kg", quantity: 1 }] });

const agent = kit.agent({ agentId, privateKey: keys.privateKey });
const decision = await agent.checkout({ mandateId, signedQuote, rationale: "weekly staples" });

if (decision.verdict === "ALLOW") {
  // decision.pay_url, decision.audit_url
} else if (decision.verdict === "STEP_UP") {
  // send the shopper to decision.approval_url
}
```

## Two credentials, two doors

They are not interchangeable, and mixing them up is the one mistake with a real blast
radius.

| Option | Header | Who holds it | What it opens |
| --- | --- | --- | --- |
| `apiKey` | `x-agentkit-key` | The agent | Catalog, quotes, checkout, orders |
| `fulfilToken` | `x-agentkit-token` | Your backend only | Binding a consent request to a real customer |

`fulfilToken` also signs authorization tokens. **Never ship it to an agent.** The SDK
enforces the split: a call through the agent door never carries the merchant token, and
the reverse is also true. There is a test for exactly this.

## Identity is not a cache

A mandate is granted to an agent id, which is derived from a public key. If you generate a
fresh keypair on each deploy, every mandate a shopper ever granted you is orphaned on the
next restart, and every purchase is refused with `MND-001` and nothing on screen to
explain why.

Store `agentId` and the private key in your database and load them at boot.

The private key is a signing key, never a payment credential. The worst an attacker who
steals it can do is propose purchases, and those still have to pass the mandate and every
policy rule.

## Refusals are answers

```js
const { AgentKitRefusal, AgentKitError } = require("@agentkit/merchant");

try {
  await agent.checkout({ mandateId, signedQuote });
} catch (err) {
  if (err instanceof AgentKitRefusal) {
    // The kernel decided. err.reasonCode is stable and safe to branch on.
    if (err.reasonCode === "CAP-001") notifyShopperCapReached();
  } else if (err instanceof AgentKitError) {
    // The transport failed. Nothing was decided; retrying is safe.
  }
}
```

A denied purchase and an unreachable kernel are never the same object. Reason codes are
stable and read identically here, in the ledger and in the dashboard.

Common codes: `MND-001` no live mandate, `CAP-001` cap exhausted, `SEC-002` unknown agent,
`INT-001` signature mismatch, `INT-003` amount or basket differs from the quote.

## Consent

The agent supplies neither the customer nor the address, and never learns either. It is
told a mandate reference; your backend resolves the address at fulfilment time.

```js
const consent = await kit.requestConsent({
  agentId,
  contact: shopper.phone,
  requestedScope: { merchants: ["mch_yourshop"], categories: ["groceries"], currency: "INR" },
  limits: {
    per_transaction_paise: "500000",
    cumulative_paise: "1500000",
    silent_threshold_paise: "50000",   // above this, the shopper is asked
    velocity_per_hour: 3,
  },
});
// Send the shopper to consent.consent_url
```

To bind that request to a real customer, mint a token from the merchant door and let the
shopper's own browser carry it:

```js
const token = kit.authorizationToken({
  requestRef: consent.request_ref,
  customerRef: user.id,
  fulfilmentRef: address.id,
  displayName: user.name,
  displayAddress: address.oneLine,
});
```

The display fields are the point. You cannot prove to the kernel that this customer id is
this person, because it is your namespace and opaque to them. So the kernel shows the
shopper the name and address you claim and lets them decline if it is not theirs. The one
party who can check is the one asked to.

The token is ref-bound and expires in ten minutes, so it cannot be replayed into another
session.

The signing key is the SHA-256 of your fulfil token, not the token itself. The kernel
stores only that hash, so it can verify your handoffs without ever holding your token in a
recoverable form, and every merchant ends up with a distinct key. The SDK does this for
you.

## API

**`new AgentKit({ baseUrl, apiKey, fulfilToken, timeoutMs, fetch })`**
`fetch` is injectable for testing. `timeoutMs` defaults to 15000.

**`AgentKit.generateKeyPair()`** — `{ publicKey, privateKey }` as raw 32-byte Buffers.

**`kit.registerAgent({ name, publicKey })`** — `{ agentId }`. Identity, never authority.

**`kit.agent({ agentId, privateKey })`** — an `Agent` that can sign. No network call.

**`kit.quote({ mandateId, items })`** — `{ quote, kid, signature }`.

**`agent.checkout({ mandateId, signedQuote, rationale, intentTtlMs })`** — a `Decision`.
Amount and basket are taken from the quote, never from the caller.

**`kit.requestConsent(...)`**, **`kit.consentStatus(ref)`**, **`kit.bindConsent(ref, token)`**,
**`kit.authorizationToken(...)`**

**`kit.audit(intentId)`** — the public record of one decision: what happened to this
intent, in order, with the hash that fixes each entry in the chain, and `chain_intact`.
Needs no credential, so the same call works from a support tool or a shopper's own page.

**`kit.searchCatalog({ mandateId, query })`**, **`kit.catalogItem(sku)`**, **`kit.mandate(id)`**,
**`kit.orderStatus(b)`**, **`kit.orderHistory(b)`**, **`kit.cancelOrder(b)`**, **`kit.reorder(b)`**

**`kit.tools()`**, **`kit.manifest()`**, **`kit.health()`**

Escape hatch: **`kit.request(method, path, { body, door, headers })`** for anything not
wrapped above.

Also exported for callers who transport signatures themselves: `canonicalise`,
`canonicalBytes`, `signPayload`, `verifyPayload`, `intentSigningPayload`,
`quoteSigningPayload`, `paiseToCanonical`.

## Tests

```
npm test                      # this package, no network
npx vitest run tests/sdk/     # from the repo root: byte-for-byte against the kernel
```

## Licence

Apache-2.0
