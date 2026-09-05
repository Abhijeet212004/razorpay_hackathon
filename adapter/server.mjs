#!/usr/bin/env node
/**
 * The AgentKit adapter.
 *
 * A container beside a merchant's application that translates their existing endpoints
 * into the three contracts AgentKit needs. It exists so that a shop with a working
 * products endpoint and a working orders endpoint can be reached by an agent without
 * changing a line of application code.
 *
 *   kernel  ->  GET  /catalog    ->  the merchant's products endpoint
 *   kernel  ->  POST /fulfil     ->  the merchant's orders endpoint
 *   shopper ->  GET  /authorize  ->  the merchant's session endpoint
 *
 * What it is not: it holds no permission, no limit and no ledger, and it makes no
 * decision. Those stay in the kernel, which is what makes them something a compromised
 * merchant cannot quietly rewrite. The adapter is inside the merchant's trust boundary
 * and needs no inbound access from the internet.
 */

import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

import { AgentKit } from "@agentkit/merchant";

import { mappingFromEnv, pluck, toMerchantOrder, toProduct } from "./mapping.mjs";

const PORT = Number(process.env.PORT ?? 7000);
const TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 8000);

const PRODUCTS_URL = process.env.MERCHANT_PRODUCTS_URL;
const ORDERS_URL = process.env.MERCHANT_ORDERS_URL;
const SESSION_URL = process.env.MERCHANT_SESSION_URL;

const FULFIL_TOKEN = process.env.AGENTKIT_FULFIL_TOKEN ?? "";
const KERNEL_URL = process.env.AGENTKIT_BASE_URL ?? "";

const map = mappingFromEnv();
const log = (message) => process.stdout.write(`[adapter] ${message}\n`);

const kit = new AgentKit({
  baseUrl: KERNEL_URL || "http://kernel:8080",
  apiKey: process.env.AGENTKIT_API_KEY ?? null,
  fulfilToken: FULFIL_TOKEN,
});

/** Every required setting checked at boot, so a typo fails here rather than mid purchase. */
function checkConfiguration() {
  const missing = [];
  if (!PRODUCTS_URL) missing.push("MERCHANT_PRODUCTS_URL");
  if (!ORDERS_URL) missing.push("MERCHANT_ORDERS_URL");
  if (!FULFIL_TOKEN) missing.push("AGENTKIT_FULFIL_TOKEN");
  if (!KERNEL_URL) missing.push("AGENTKIT_BASE_URL");
  if (missing.length > 0) {
    process.stderr.write(`[adapter] not configured: ${missing.join(", ")}\n`);
    process.exit(2);
  }
  if (!SESSION_URL) {
    log("no MERCHANT_SESSION_URL, so /authorize is disabled and you must host that page yourself");
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

async function upstream(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Compared in constant time. Length first, because timingSafeEqual throws on a mismatch. */
function authorised(req) {
  const presented = String(req.headers["x-agentkit-token"] ?? "");
  if (FULFIL_TOKEN.length === 0 || presented.length !== FULFIL_TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(FULFIL_TOKEN));
}

/* ------------------------------------------------------------------ catalog */

async function catalog(_req, res) {
  const response = await upstream(PRODUCTS_URL);
  if (!response.ok) {
    log(`products endpoint returned ${response.status}`);
    return json(res, 502, { error: "the products endpoint did not answer" });
  }

  const body = await response.json();
  const rows = map.root === "" ? body : pluck(body, map.root);

  if (!Array.isArray(rows)) {
    log(`PRODUCTS_ROOT "${map.root}" is not an array in the response`);
    return json(res, 502, {
      error: `expected an array at "${map.root}"`,
      hint: "set PRODUCTS_ROOT to the path where your products array lives, or empty if it is the root",
    });
  }

  const products = [];
  let skipped = 0;
  for (const row of rows) {
    try {
      const product = toProduct(row, map);
      if (product === null) { skipped += 1; continue; }
      products.push(product);
    } catch (error) {
      // One unmappable row must not take the whole catalog down.
      skipped += 1;
      log(`skipped a product: ${error.message}`);
    }
  }

  if (skipped > 0) log(`mapped ${products.length} products, skipped ${skipped}`);
  return json(res, 200, { products });
}

/* ------------------------------------------------------------------ fulfil */

async function fulfil(req, res) {
  if (!authorised(req)) return json(res, 401, { error: "unauthorised" });

  const order = await readJson(req);
  if (order === null) return json(res, 400, { error: "body is not JSON" });
  if (!order.intent_id || !Array.isArray(order.items) || order.items.length === 0) {
    return json(res, 400, { error: "intent_id and items are required" });
  }

  const response = await upstream(ORDERS_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Passed through so the merchant's own endpoint can authenticate us too.
      ...(process.env.MERCHANT_ORDERS_TOKEN
        ? { authorization: `Bearer ${process.env.MERCHANT_ORDERS_TOKEN}` }
        : {}),
    },
    body: JSON.stringify(toMerchantOrder(order, map)),
  });

  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }

  if (!response.ok) {
    log(`orders endpoint returned ${response.status} for ${order.intent_id}`);
    return json(res, 502, { error: "the orders endpoint refused the order", upstream: body });
  }

  const orderId = pluck(body, map.orderIdField) ?? pluck(body, "id") ?? pluck(body, "_id");
  if (orderId === undefined) {
    log(`orders endpoint gave no id at "${map.orderIdField}" for ${order.intent_id}`);
    return json(res, 502, {
      error: "the orders endpoint returned no order id",
      hint: `set ORDER_ID_RESPONSE_FIELD to the path where your endpoint returns it`,
    });
  }

  return json(res, 200, { order_id: String(orderId) });
}

/* --------------------------------------------------------------- authorize */

/**
 * Where a shopper lands to approve an agent.
 *
 * GET renders, POST commits. Binding on a GET would make this reachable by a link, an
 * image tag or a browser prefetch. The customer comes from the merchant's own session
 * endpoint, never from the request, and the chosen address is checked against the list
 * that endpoint returned rather than trusted.
 */
async function authorize(req, res, url) {
  if (!SESSION_URL) return json(res, 501, { error: "MERCHANT_SESSION_URL is not configured" });

  const response = await upstream(SESSION_URL, {
    // Their session, carried on their own cookie. The adapter never mints one.
    headers: {
      ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
      ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
    },
  });

  if (!response.ok) return json(res, 401, { error: "sign in to authorise an assistant" });

  const who = await response.json();
  const userId = pluck(who, process.env.SESSION_ID_FIELD ?? "id");
  const userName = pluck(who, process.env.SESSION_NAME_FIELD ?? "name");
  const addresses = pluck(who, process.env.SESSION_ADDRESSES_FIELD ?? "addresses") ?? [];

  if (userId === undefined) return json(res, 401, { error: "sign in to authorise an assistant" });

  const listed = (Array.isArray(addresses) ? addresses : []).map((a) => ({
    id: String(pluck(a, process.env.ADDRESS_ID_FIELD ?? "id") ?? ""),
    line: String(pluck(a, process.env.ADDRESS_LINE_FIELD ?? "line") ?? ""),
  })).filter((a) => a.id !== "");

  if (req.method === "GET") {
    const ref = url.searchParams.get("ref");
    if (!ref) return json(res, 400, { error: "ref is required" });
    if (listed.length === 0) {
      return json(res, 409, {
        error: "save a delivery address first, an assistant may only deliver to one you chose",
      });
    }
    return json(res, 200, { request_ref: ref, shopper: userName ?? null, addresses: listed });
  }

  const body = await readJson(req);
  if (body === null) return json(res, 400, { error: "body is not JSON" });
  if (!body.ref) return json(res, 400, { error: "ref is required" });

  const chosen = body.address_id
    ? listed.find((a) => a.id === String(body.address_id))
    : listed[0];
  if (!chosen) return json(res, 400, { error: "that address is not one of yours" });

  const token = kit.authorizationToken({
    requestRef: String(body.ref),
    customerRef: String(userId),
    fulfilmentRef: chosen.id,
    displayName: userName,
    displayAddress: chosen.line,
  });

  // Built from configuration. Echoing a query parameter here would be an open redirect.
  return json(res, 200, { consent_url: kit.consentUrl(String(body.ref), token) });
}

/* ------------------------------------------------------------------ server */

checkConfiguration();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://adapter");

  try {
    if (url.pathname === "/health") {
      return json(res, 200, { ok: true, service: "agentkit-adapter" });
    }
    if (url.pathname === "/catalog" && req.method === "GET") return await catalog(req, res);
    if (url.pathname === "/fulfil" && req.method === "POST") return await fulfil(req, res);
    if (url.pathname === "/authorize" && (req.method === "GET" || req.method === "POST")) {
      return await authorize(req, res, url);
    }
    return json(res, 404, { error: "not found" });
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    log(`${url.pathname} failed: ${timedOut ? `upstream timed out after ${TIMEOUT_MS}ms` : error.message}`);
    return json(res, 502, { error: timedOut ? "upstream timed out" : "upstream failed" });
  }
});

server.listen(PORT, () => {
  // The assigned port, not the requested one: PORT=0 asks the OS to choose.
  log(`listening on ${server.address().port}`);
  log(`catalog   <- ${PRODUCTS_URL}`);
  log(`orders    -> ${ORDERS_URL}`);
  log(`session   <- ${SESSION_URL ?? "(disabled)"}`);
});
