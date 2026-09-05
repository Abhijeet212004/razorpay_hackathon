"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { AgentKit } = require("..");

const ORDER = {
    intent_id: "int_1",
    customer_ref: "usr_1",
    fulfilment_ref: "adr_1",
    items: [{ sku: "rice", quantity: 1 }],
    amount_paise: "42000",
    payment_id: "pay_1",
    audit_url: "https://k.example/audit/int_1",
};

function harness({ lookup, present, token = "ft_secret" } = {}) {
    const kit = new AgentKit({ baseUrl: "https://k.example", fulfilToken: "ft_secret" });
    const handler = kit.verify({ lookup, present });
    return (body, headers = { "x-agentkit-token": token }) => new Promise((resolve) => {
        const req = { headers, body };
        const res = {
            status(c) { this.c = c; return this; },
            json(b) { resolve({ status: this.c, body: b, req }); return this; },
        };
        handler(req, res, () => resolve({ status: null, body: null, req }));
    });
}

test("a request without the shared secret is refused", async () => {
    const call = harness();
    const res = await call(ORDER, {});
    assert.equal(res.status, 401);
});

test("a wrong secret is refused, whatever its length", async () => {
    const call = harness();
    assert.equal((await call(ORDER, { "x-agentkit-token": "wrong" })).status, 401);
    assert.equal((await call(ORDER, { "x-agentkit-token": "ft_secretX" })).status, 401);
    assert.equal((await call(ORDER, { "x-agentkit-token": "ft_secreT" })).status, 401);
});

test("a valid call reaches the handler with a parsed order", async () => {
    const call = harness();
    const res = await call(ORDER);
    assert.equal(res.status, null);
    assert.equal(res.req.agentOrder.intentId, "int_1");
    assert.equal(res.req.agentOrder.customerRef, "usr_1");
    assert.equal(res.req.agentOrder.fulfilmentRef, "adr_1");
    assert.equal(res.req.agentOrder.paymentId, "pay_1");
});

test("the amount stays a decimal string", async () => {
    const call = harness();
    const res = await call({ ...ORDER, amount_paise: "9007199254740993" });
    assert.equal(res.req.agentOrder.amountPaise, "9007199254740993");
    assert.equal(typeof res.req.agentOrder.amountPaise, "string");
});

test("a retried intent returns the order already made", async () => {
    const call = harness({ lookup: async (id) => (id === "int_1" ? { id: "ord_9" } : null) });
    const res = await call(ORDER);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { order_id: "ord_9", deduplicated: true });
});

test("present shapes the deduplicated answer", async () => {
    const call = harness({
        lookup: async () => ({ _id: "ord_9" }),
        present: (o) => ({ order_id: o._id, already: true }),
    });
    const res = await call(ORDER);
    assert.deepEqual(res.body, { order_id: "ord_9", already: true });
});

test("without a lookup the request is let through", async () => {
    const call = harness();
    const res = await call(ORDER);
    assert.equal(res.status, null);
});

test("a body missing intent_id or items is rejected", async () => {
    const call = harness();
    assert.equal((await call({ ...ORDER, intent_id: undefined })).status, 400);
    assert.equal((await call({ ...ORDER, items: [] })).status, 400);
    assert.equal((await call({})).status, 400);
});

test("the secret is checked before the body is looked at", async () => {
    let touched = false;
    const call = harness({ lookup: async () => { touched = true; return null; } });
    await call(ORDER, { "x-agentkit-token": "wrong" });
    assert.equal(touched, false);
});
