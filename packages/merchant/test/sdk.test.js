"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
    AgentKit, AgentKitRefusal, AgentKitError,
    generateKeyPair, signPayload, verifyPayload,
    canonicalise, intentSigningPayload, paiseToCanonical,
} = require("..");

test("canonicalisation sorts keys and is stable", () => {
    assert.equal(canonicalise({ b: 2, a: 1 }), '{"a":1,"b":2}');
    assert.equal(canonicalise({ z: [3, 1, 2] }), '{"z":[3,1,2]}');
    assert.equal(canonicalise({ n: null, t: true }), '{"n":null,"t":true}');
    assert.throws(() => canonicalise(1.5), TypeError);
});

test("money is signed as a decimal string whatever the caller holds", () => {
    assert.equal(paiseToCanonical(42000n), "42000");
    assert.equal(paiseToCanonical("42000"), "42000");
    assert.equal(paiseToCanonical(42000), "42000");
    // Beyond float precision: must not silently round.
    assert.equal(paiseToCanonical(9007199254740993n), "9007199254740993");
    assert.throws(() => paiseToCanonical(1.5), TypeError);
    assert.throws(() => paiseToCanonical("12.5"), TypeError);
});

test("a signed intent verifies, and a tampered one does not", () => {
    const keys = generateKeyPair();
    const intent = {
        intent_id: "int_1", type: "purchase", mandate_id: "mnd_1", quote_id: "qte_1",
        merchant_id: "mch_1", amount_paise: "42000", basket_hash: "abc",
        rationale: "weekly staples", nonce: "ff00", expires_at: "2030-01-01T00:00:00.000Z",
    };
    const signature = signPayload(keys.privateKey, intentSigningPayload(intent));

    assert.ok(verifyPayload(keys.publicKey, intentSigningPayload(intent), signature));
    assert.equal(
        verifyPayload(keys.publicKey, intentSigningPayload({ ...intent, amount_paise: "1" }), signature),
        false,
    );
});

test("keys survive a hex round trip", () => {
    const keys = generateKeyPair();
    const payload = { a: 1 };
    const signature = signPayload(keys.privateKey.toString("hex"), payload);
    assert.ok(verifyPayload(keys.publicKey.toString("hex"), payload, signature.toString("hex")));
});

test("the fulfil token never travels through the agent door", async () => {
    const seen = [];
    const kit = new AgentKit({
        baseUrl: "https://k.example",
        apiKey: "ak_public",
        fulfilToken: "secret_do_not_leak",
        fetch: async (_url, init) => {
            seen.push(init.headers);
            return { ok: true, status: 200, text: async () => "{}" };
        },
    });
    await kit.quote({ mandateId: "mnd_1", items: [] });
    assert.equal(seen[0]["x-agentkit-key"], "ak_public");
    assert.equal(seen[0]["x-agentkit-token"], undefined);
});

test("the merchant door carries the fulfil token and not the api key", async () => {
    const seen = [];
    const kit = new AgentKit({
        baseUrl: "https://k.example",
        apiKey: "ak_public",
        fulfilToken: "mt_secret",
        fetch: async (_url, init) => {
            seen.push(init.headers);
            return { ok: true, status: 200, text: async () => "{}" };
        },
    });
    await kit.bindConsent("creq_1", { customerRef: "usr_1", fulfilmentRef: "adr_1" });
    assert.equal(seen[0]["x-agentkit-token"], "mt_secret");
    assert.equal(seen[0]["x-agentkit-key"], undefined);
});

test("a reason code comes back as a refusal, not a transport error", async () => {
    const kit = new AgentKit({
        baseUrl: "https://k.example",
        fetch: async () => ({
            ok: false, status: 403,
            text: async () => JSON.stringify({ reason_code: "MND-001", message: "no mandate" }),
        }),
    });
    await assert.rejects(
        () => kit.quote({ mandateId: "mnd_x", items: [] }),
        (err) => err instanceof AgentKitRefusal && err.reasonCode === "MND-001",
    );
});

test("a transport failure is not mistaken for a refusal", async () => {
    const kit = new AgentKit({
        baseUrl: "https://k.example",
        fetch: async () => { throw new Error("ECONNREFUSED"); },
    });
    await assert.rejects(
        () => kit.health(),
        (err) => err instanceof AgentKitError && !(err instanceof AgentKitRefusal),
    );
});

test("checkout takes amount and basket from the quote, never the caller", async () => {
    let sent;
    const kit = new AgentKit({
        baseUrl: "https://k.example",
        fetch: async (_url, init) => {
            sent = JSON.parse(init.body);
            return { ok: true, status: 200, text: async () => "{}" };
        },
    });
    const keys = generateKeyPair();
    const agent = kit.agent({ agentId: "agt_1", privateKey: keys.privateKey });
    const signedQuote = {
        quote: {
            quote_id: "qte_1", merchant_id: "mch_1", mandate_id: "mnd_1",
            amount_paise: "42000", basket_hash: "abc",
        },
        signature: "00",
    };

    await agent.checkout({ mandateId: "mnd_1", signedQuote, rationale: "why" });

    assert.equal(sent.signedIntent.intent.amount_paise, "42000");
    assert.equal(sent.signedIntent.intent.basket_hash, "abc");
    assert.equal(sent.signedIntent.agent_id, "agt_1");
    // The signature must cover what was actually sent.
    assert.ok(verifyPayload(
        keys.publicKey,
        intentSigningPayload(sent.signedIntent.intent),
        sent.signedIntent.signature,
    ));
});

test("an authorization token is ref-bound and tamper-evident", () => {
    const kit = new AgentKit({ baseUrl: "https://k.example", fulfilToken: "mt_secret" });
    const token = kit.authorizationToken({
        requestRef: "creq_1", customerRef: "cus_1", fulfilmentRef: "ful_1",
        displayName: "A Shopper", displayAddress: "12 Example Road",
    });
    const [payload, signature] = token.split(".");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));

    assert.equal(decoded.ref, "creq_1");
    assert.equal(decoded.displayName, "A Shopper");
    assert.ok(decoded.expiresAt > Date.now());
    assert.ok(signature.length > 0);

    const other = new AgentKit({ baseUrl: "https://k.example", fulfilToken: "different" });
    assert.notEqual(other.authorizationToken({
        requestRef: "creq_1", customerRef: "cus_1", fulfilmentRef: "ful_1",
        displayName: "A Shopper", displayAddress: "12 Example Road",
    }).split(".")[1], signature);
});

test("a missing fulfil token is refused before any network call", () => {
    const kit = new AgentKit({ baseUrl: "https://k.example" });
    assert.throws(() => kit.authorizationToken({
        requestRef: "creq_1", customerRef: "c", fulfilmentRef: "f",
    }), TypeError);
});
