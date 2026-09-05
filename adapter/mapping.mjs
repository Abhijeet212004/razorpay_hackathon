/**
 * Field mapping, driven entirely by configuration.
 *
 * The adapter exists so a merchant does not have to change their application. Their
 * products endpoint already returns something; it just does not use our field names. Each
 * mapping below is a dotted path into their response, so `category.name` and
 * `attributes.0.value` both work.
 *
 * Nothing here makes a decision. It renames fields and converts money, and that is all.
 * Permissions, limits and the ledger stay in the kernel, which is what makes them
 * something a compromised merchant cannot quietly rewrite.
 */

/** Reads a dotted path. Array indices are numeric segments: `variants.0.price`. */
export function pluck(source, path) {
  if (path === undefined || path === null || path === "") return undefined;
  let cursor = source;
  for (const segment of String(path).split(".")) {
    if (cursor === null || cursor === undefined) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

/**
 * Money to integer paise, as a string.
 *
 * A merchant's endpoint may hand us rupees as a float, rupees as a string, or paise as an
 * integer, and the difference matters: read 499.99 rupees as paise and the shopper is
 * charged four rupees. The unit is configuration rather than a guess, and the arithmetic
 * goes through a string so a float never rounds a price.
 */
export function toPaise(value, unit = "rupees") {
  if (value === undefined || value === null || value === "") return null;

  const text = String(value).trim().replace(/[^0-9.\-]/g, "");
  if (text === "" || text === "-") return null;

  if (unit === "paise") {
    if (!/^-?\d+$/.test(text)) throw new TypeError(`paise must be a whole number, received ${value}`);
    return BigInt(text).toString(10);
  }

  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > 2) {
    // More precision than a rupee amount can carry. Round half up rather than truncate.
    const rounded = Math.round(Number(text) * 100);
    if (!Number.isSafeInteger(rounded)) throw new TypeError(`price cannot be represented exactly: ${value}`);
    return String(rounded);
  }
  const paise = BigInt(whole || "0") * 100n
    + BigInt((fraction + "00").slice(0, 2)) * (text.startsWith("-") ? -1n : 1n);
  return paise.toString(10);
}

/** One of the merchant's products, in the shape the kernel's catalog sync reads. */
export function toProduct(row, map) {
  const id = pluck(row, map.id);
  if (id === undefined || id === null || String(id) === "") return null;

  return {
    _id: String(id),
    name: String(pluck(row, map.name) ?? ""),
    description: String(pluck(row, map.description) ?? ""),
    category: String(pluck(row, map.category) ?? "uncategorised"),
    // The kernel multiplies this by 100, so it must be rupees whatever the source used.
    price: Number(toPaise(pluck(row, map.price), map.priceUnit) ?? 0) / 100,
    stock: Number(pluck(row, map.stock) ?? 0),
  };
}

/** An agent's order, in the shape the merchant's own orders endpoint expects. */
export function toMerchantOrder(order, map) {
  const body = {};
  const set = (path, value) => {
    if (!path) return;
    const segments = String(path).split(".");
    let cursor = body;
    for (const segment of segments.slice(0, -1)) {
      cursor[segment] = cursor[segment] ?? {};
      cursor = cursor[segment];
    }
    cursor[segments[segments.length - 1]] = value;
  };

  set(map.orderCustomer, order.customer_ref);
  set(map.orderAddress, order.fulfilment_ref);
  set(map.orderItems, order.items);
  set(map.orderReference, order.intent_id);
  set(map.orderPayment, order.payment_id);

  // Both, so the merchant can take whichever their schema stores. Amounts stay strings:
  // a float here is a rounded total on somebody's invoice.
  set(map.orderAmountPaise, order.amount_paise);
  if (map.orderAmountRupees) {
    const paise = BigInt(order.amount_paise ?? "0");
    const sign = paise < 0n ? "-" : "";
    const abs = paise < 0n ? -paise : paise;
    set(map.orderAmountRupees, `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`);
  }

  if (map.orderPlacedBy) set(map.orderPlacedBy, "agent");
  return body;
}

/** Reads the mapping out of the environment, with the defaults a MERN shop already matches. */
export function mappingFromEnv(env = process.env) {
  return {
    root: env.PRODUCTS_ROOT ?? "products",
    id: env.PRODUCT_ID ?? "_id",
    name: env.PRODUCT_NAME ?? "name",
    description: env.PRODUCT_DESCRIPTION ?? "description",
    category: env.PRODUCT_CATEGORY ?? "category",
    price: env.PRODUCT_PRICE ?? "price",
    priceUnit: env.PRODUCT_PRICE_UNIT ?? "rupees",
    stock: env.PRODUCT_STOCK ?? "stock",

    orderCustomer: env.ORDER_CUSTOMER_FIELD ?? "customer_ref",
    orderAddress: env.ORDER_ADDRESS_FIELD ?? "fulfilment_ref",
    orderItems: env.ORDER_ITEMS_FIELD ?? "items",
    orderReference: env.ORDER_REFERENCE_FIELD ?? "intent_id",
    orderPayment: env.ORDER_PAYMENT_FIELD ?? "payment_id",
    orderAmountPaise: env.ORDER_AMOUNT_PAISE_FIELD ?? "amount_paise",
    orderAmountRupees: env.ORDER_AMOUNT_RUPEES_FIELD ?? "",
    orderPlacedBy: env.ORDER_PLACED_BY_FIELD ?? "placed_by",
    orderIdField: env.ORDER_ID_RESPONSE_FIELD ?? "order_id",
  };
}
