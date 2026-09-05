import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

/**
 * The adapter against a merchant that does not use any of our field names.
 *
 * A shop with `id`, `title`, `category.name` and paise-denominated prices is the whole
 * point of the adapter existing, so that is what the fake merchant returns.
 */

const FULFIL_TOKEN = "adapter-test-token";
let merchant, adapter, merchantPort, adapterPort, received;

function json(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(payload);
}

before(async () => {
    received = [];

    merchant = createServer(async (req, res) => {
        if (req.url === "/products") {
            return json(res, 200, {
                data: {
                    items: [
                        { id: 1, title: "Rice 5kg", category: { name: "Groceries" }, price: { amount: "42000" }, inventory: { count: 4 } },
                        { id: 2, title: "Soap", category: { name: "Household" }, price: { amount: "3550" }, inventory: { count: 0 } },
                        { title: "no id, must be dropped" },
                    ],
                },
            });
        }
        if (req.url === "/orders" && req.method === "POST") {
            const chunks = [];
            for await (const c of req) chunks.push(c);
            received.push(JSON.parse(Buffer.concat(chunks).toString()));
            return json(res, 201, { data: { orderNumber: "ORD-9" } });
        }
        if (req.url === "/me") {
            if (req.headers.cookie !== "session=valid") return json(res, 401, { error: "no" });
            return json(res, 200, {
                id: "usr_1", name: "A Shopper",
                addresses: [{ id: "adr_1", line: "12 Example Road" }, { id: "adr_2", line: "9 Other Street" }],
            });
        }
        return json(res, 404, {});
    });
    merchant.listen(0);
    await once(merchant, "listening");
    merchantPort = merchant.address().port;

    adapter = spawn(process.execPath, ["server.mjs"], {
        cwd: new URL("..", import.meta.url).pathname,
        env: {
            ...process.env,
            PORT: "0",
            MERCHANT_PRODUCTS_URL: `http://127.0.0.1:${merchantPort}/products`,
            MERCHANT_ORDERS_URL: `http://127.0.0.1:${merchantPort}/orders`,
            MERCHANT_SESSION_URL: `http://127.0.0.1:${merchantPort}/me`,
            AGENTKIT_FULFIL_TOKEN: FULFIL_TOKEN,
            AGENTKIT_BASE_URL: "https://kernel.example",
            PRODUCTS_ROOT: "data.items",
            PRODUCT_ID: "id",
            PRODUCT_NAME: "title",
            PRODUCT_CATEGORY: "category.name",
            PRODUCT_PRICE: "price.amount",
            PRODUCT_PRICE_UNIT: "paise",
            PRODUCT_STOCK: "inventory.count",
            ORDER_CUSTOMER_FIELD: "user.id",
            ORDER_ITEMS_FIELD: "lines",
            ORDER_ID_RESPONSE_FIELD: "data.orderNumber",
        },
        stdio: ["ignore", "pipe", "pipe"],
    });

    // The adapter prints the port it settled on. Keep draining stdout afterwards: closing
    // it would give the child an EPIPE on its next log line.
    adapterPort = await new Promise((resolve, reject) => {
        let buffered = "";
        adapter.stdout.setEncoding("utf8");
        adapter.stdout.on("data", (chunk) => {
            buffered += chunk;
            const match = buffered.match(/listening on (\d+)/);
            if (match) resolve(Number(match[1]));
        });
        adapter.stderr.setEncoding("utf8");
        adapter.stderr.on("data", (chunk) => { buffered += chunk; });
        adapter.once("exit", (code) => reject(new Error(`adapter exited ${code}: ${buffered}`)));
    });
});

after(() => {
    adapter?.kill();
    merchant?.close();
});

const call = (path, init) => fetch(`http://127.0.0.1:${adapterPort}${path}`, init);

test("health answers", async () => {
    const res = await call("/health");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
});

test("the catalog is translated into the shape the kernel reads", async () => {
    const res = await call("/catalog");
    assert.equal(res.status, 200);
    const { products } = await res.json();

    // The row with no id is dropped rather than given a made up one.
    assert.equal(products.length, 2);
    assert.deepEqual(products[0], {
        _id: "1", name: "Rice 5kg", description: "", category: "Groceries", price: 420, stock: 4,
    });
    // Paise in, rupees out, because the kernel multiplies by 100.
    assert.equal(products[1].price, 35.5);
});

test("fulfilment without the shared secret is refused", async () => {
    const res = await call("/fulfil", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent_id: "int_1", items: [{ sku: "x", quantity: 1 }] }),
    });
    assert.equal(res.status, 401);
    assert.equal(received.length, 0);
});

test("a fulfilled order reaches the merchant in their own field names", async () => {
    const res = await call("/fulfil", {
        method: "POST",
        headers: { "content-type": "application/json", "x-agentkit-token": FULFIL_TOKEN },
        body: JSON.stringify({
            intent_id: "int_1", customer_ref: "usr_1", fulfilment_ref: "adr_1",
            items: [{ sku: "rice", quantity: 2 }], amount_paise: "42000", payment_id: "pay_1",
        }),
    });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { order_id: "ORD-9" });

    const sent = received.at(-1);
    assert.equal(sent.user.id, "usr_1");
    assert.deepEqual(sent.lines, [{ sku: "rice", quantity: 2 }]);
    assert.equal(sent.placed_by, "agent");
});

test("a body without an intent or items is rejected before the merchant is called", async () => {
    const before = received.length;
    const res = await call("/fulfil", {
        method: "POST",
        headers: { "content-type": "application/json", "x-agentkit-token": FULFIL_TOKEN },
        body: JSON.stringify({ items: [] }),
    });
    assert.equal(res.status, 400);
    assert.equal(received.length, before);
});

test("authorize needs the shopper's own session", async () => {
    const anonymous = await call("/authorize?ref=creq_1");
    assert.equal(anonymous.status, 401);

    const signedIn = await call("/authorize?ref=creq_1", { headers: { cookie: "session=valid" } });
    assert.equal(signedIn.status, 200);
    const body = await signedIn.json();
    assert.equal(body.shopper, "A Shopper");
    assert.deepEqual(body.addresses.map((a) => a.id), ["adr_1", "adr_2"]);
});

test("a GET never mints a token, because a link must not bind consent", async () => {
    const res = await call("/authorize?ref=creq_1", { headers: { cookie: "session=valid" } });
    assert.equal(JSON.stringify(await res.json()).includes("consent_url"), false);
});

test("a POST commits, and the customer comes from the session not the body", async () => {
    const res = await call("/authorize", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: "session=valid" },
        body: JSON.stringify({ ref: "creq_1", address_id: "adr_2", customer_ref: "usr_victim" }),
    });
    assert.equal(res.status, 200);

    const { consent_url } = await res.json();
    assert.ok(consent_url.startsWith("https://kernel.example/consent/creq_1?auth="));

    const auth = new URL(consent_url).searchParams.get("auth");
    const claims = JSON.parse(Buffer.from(auth.split(".")[0], "base64url").toString());
    assert.equal(claims.customerRef, "usr_1");
    assert.equal(claims.fulfilmentRef, "adr_2");
});

test("an address that is not theirs is refused", async () => {
    const res = await call("/authorize", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: "session=valid" },
        body: JSON.stringify({ ref: "creq_1", address_id: "adr_somebody_else" }),
    });
    assert.equal(res.status, 400);
});
