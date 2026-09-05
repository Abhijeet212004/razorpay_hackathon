import { test } from "node:test";
import assert from "node:assert/strict";

import { mappingFromEnv, pluck, toMerchantOrder, toPaise, toProduct } from "../mapping.mjs";

test("pluck reads dotted paths and array indices", () => {
    assert.equal(pluck({ a: { b: [{ c: 7 }] } }, "a.b.0.c"), 7);
    assert.equal(pluck({ a: 1 }, "a.b.c"), undefined);
    assert.equal(pluck({}, ""), undefined);
});

test("money converts from whatever the merchant returns", () => {
    assert.equal(toPaise(499.99), "49999");
    assert.equal(toPaise("1234.50"), "123450");
    assert.equal(toPaise("₹1,234.50"), "123450");
    assert.equal(toPaise(100), "10000");
    assert.equal(toPaise("42000", "paise"), "42000");
    assert.equal(toPaise("7.5"), "750");
    assert.equal(toPaise(null), null);
});

test("reading rupees as paise would charge the wrong amount, so the unit is explicit", () => {
    // The same number means two very different prices.
    assert.equal(toPaise("499", "rupees"), "49900");
    assert.equal(toPaise("499", "paise"), "499");
});

test("a price with more precision than a rupee carries is rounded, not truncated", () => {
    assert.equal(toPaise("10.005"), "1001");
    assert.equal(toPaise("10.004"), "1000");
});

test("paise must be whole", () => {
    assert.throws(() => toPaise("12.5", "paise"), TypeError);
});

test("a product maps into the shape the kernel reads", () => {
    const map = mappingFromEnv({
        PRODUCT_ID: "id", PRODUCT_NAME: "title", PRODUCT_CATEGORY: "category.name",
        PRODUCT_PRICE: "price.amount", PRODUCT_PRICE_UNIT: "paise", PRODUCT_STOCK: "inventory.count",
    });
    const product = toProduct({
        id: 42, title: "Rice 5kg", category: { name: "Groceries" },
        price: { amount: "42000" }, inventory: { count: 9 },
    }, map);

    assert.equal(product._id, "42");
    assert.equal(product.name, "Rice 5kg");
    assert.equal(product.category, "Groceries");
    // The kernel multiplies by 100, so this has to be rupees.
    assert.equal(product.price, 420);
    assert.equal(product.stock, 9);
});

test("a product with no id is dropped rather than given a made up one", () => {
    const map = mappingFromEnv();
    assert.equal(toProduct({ name: "no id" }, map), null);
    assert.equal(toProduct({ _id: "", name: "blank id" }, map), null);
});

test("an order maps into the merchant's own field names", () => {
    const map = mappingFromEnv({
        ORDER_CUSTOMER_FIELD: "user.id",
        ORDER_ADDRESS_FIELD: "shipping.addressId",
        ORDER_ITEMS_FIELD: "lines",
        ORDER_REFERENCE_FIELD: "meta.reference",
        ORDER_AMOUNT_RUPEES_FIELD: "total",
    });
    const body = toMerchantOrder({
        intent_id: "int_1", customer_ref: "usr_1", fulfilment_ref: "adr_1",
        items: [{ sku: "rice", quantity: 1 }], amount_paise: "42000", payment_id: "pay_1",
    }, map);

    assert.equal(body.user.id, "usr_1");
    assert.equal(body.shipping.addressId, "adr_1");
    assert.deepEqual(body.lines, [{ sku: "rice", quantity: 1 }]);
    assert.equal(body.meta.reference, "int_1");
    assert.equal(body.total, "420.00");
    assert.equal(body.placed_by, "agent");
});

test("rupee totals keep their paise rather than becoming a float", () => {
    const map = mappingFromEnv({ ORDER_AMOUNT_RUPEES_FIELD: "total" });
    assert.equal(toMerchantOrder({ amount_paise: "6399" }, map).total, "63.99");
    assert.equal(toMerchantOrder({ amount_paise: "100" }, map).total, "1.00");
    assert.equal(toMerchantOrder({ amount_paise: "5" }, map).total, "0.05");
});
