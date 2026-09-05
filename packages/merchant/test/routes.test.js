"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { AgentKit } = require("..");

const SHOPPER = { id: "usr_1", name: "A Shopper" };
const ADDRESSES = [
    { id: "adr_1", label: "Home", line: "12 Example Road, Pune" },
    { id: "adr_2", label: "Work", line: "9 Other Street, Pune" },
];

function harness({ user = SHOPPER, list = ADDRESSES } = {}) {
    const kit = new AgentKit({
        baseUrl: "https://k.example",
        fulfilToken: "ft_secret",
    });
    const handler = kit.routes({
        session: () => user,
        addresses: async () => list,
        kernelUrl: "https://kernel.example",
    });
    const call = (method, url, body) => new Promise((resolve) => {
        const res = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
        };
        handler({ method, url, body }, res, () => resolve({ status: 404, body: null }));
    });
    return { kit, call };
}

test("GET renders the shopper's own addresses", async () => {
    const { call } = harness();
    const res = await call("GET", "/authorize?ref=creq_1");
    assert.equal(res.status, 200);
    assert.equal(res.body.request_ref, "creq_1");
    assert.equal(res.body.shopper, "A Shopper");
    assert.deepEqual(res.body.addresses.map((a) => a.id), ["adr_1", "adr_2"]);
});

test("GET never mints a token, because a link must not bind consent", async () => {
    const { call } = harness();
    const res = await call("GET", "/authorize?ref=creq_1");
    assert.equal(JSON.stringify(res.body).includes("consent_url"), false);
});

test("POST commits and returns a consent url", async () => {
    const { call } = harness();
    const res = await call("POST", "/authorize", { ref: "creq_1", address_id: "adr_2" });
    assert.equal(res.status, 200);
    assert.match(res.body.consent_url, /^https:\/\/kernel\.example\/consent\/creq_1\?auth=/);
});

test("the address must be one of the shopper's own", async () => {
    const { call } = harness();
    const res = await call("POST", "/authorize", { ref: "creq_1", address_id: "adr_someone_else" });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /not one of yours/);
});

test("the customer reference comes from the session, never the body", async () => {
    const { call } = harness();
    const res = await call("POST", "/authorize", {
        ref: "creq_1",
        customerRef: "usr_victim",
        customer_ref: "usr_victim",
    });
    const auth = new URL(res.body.consent_url).searchParams.get("auth");
    const claims = JSON.parse(Buffer.from(auth.split(".")[0], "base64url").toString("utf8"));
    assert.equal(claims.customerRef, "usr_1");
});

test("the redirect target is configuration, not a query parameter", async () => {
    const { call } = harness();
    const res = await call("POST", "/authorize?next=https://evil.example", {
        ref: "creq_1",
        redirect: "https://evil.example",
        consent_url: "https://evil.example",
    });
    assert.ok(res.body.consent_url.startsWith("https://kernel.example/"));
});

test("an anonymous visitor is refused before any address is read", async () => {
    let touched = false;
    const kit = new AgentKit({ baseUrl: "https://k.example", fulfilToken: "ft" });
    const handler = kit.routes({
        session: () => null,
        addresses: async () => { touched = true; return ADDRESSES; },
    });
    const res = await new Promise((resolve) => {
        const r = { status(c) { this.c = c; return this; }, json(b) { resolve({ status: this.c, body: b }); } };
        handler({ method: "GET", url: "/authorize?ref=creq_1" }, r, () => {});
    });
    assert.equal(res.status, 401);
    assert.equal(touched, false);
});

test("a shopper with no saved address is told so rather than defaulted", async () => {
    const { call } = harness({ list: [] });
    const res = await call("GET", "/authorize?ref=creq_1");
    assert.equal(res.status, 409);
    assert.match(res.body.error, /address/);
});

test("ref is required on both verbs", async () => {
    const { call } = harness();
    assert.equal((await call("GET", "/authorize")).status, 400);
    assert.equal((await call("POST", "/authorize", {})).status, 400);
});

test("other paths fall through to the next handler", async () => {
    const { call } = harness();
    assert.equal((await call("GET", "/something-else")).status, 404);
});
