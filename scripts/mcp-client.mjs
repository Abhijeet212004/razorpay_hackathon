#!/usr/bin/env node
/**
 * An MCP client, doing what Claude Desktop does.
 *
 * It speaks JSON-RPC 2.0 over Streamable HTTP, discovers the tools, and shops. It holds
 * no key, signs nothing, and knows nothing about mandates, quotes or reservations — it
 * reads tool descriptions and follows them, which is exactly what a model does.
 */
const MERCHANT = process.env.MERCHANT_URL ?? "http://localhost:58080";

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const no = (s) => `\x1b[31m${s}\x1b[0m`;
const hm = (s) => `\x1b[33m${s}\x1b[0m`;

let sessionId;
let nextId = 1;

async function rpc(method, params) {
  const res = await fetch(`${MERCHANT}/agent/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const issued = res.headers.get("mcp-session-id");
  if (issued) sessionId = issued;
  const body = await res.json();
  if (body.error) throw new Error(`${body.error.code}: ${body.error.message}`);
  return body.result;
}

/** tools/call returns text content; a model reads it, so we parse it the same way. */
async function tool(name, args = {}) {
  const result = await rpc("tools/call", { name, arguments: args });
  const parsed = JSON.parse(result.content[0].text);
  return { ...parsed, isError: result.isError === true };
}

const step = (n, t, s) => {
  console.log(`\n${bold(`${n}. ${t}`)}`);
  if (s) console.log(dim(`   ${s}`));
};
const line = (k, v) => console.log(`   ${String(k).padEnd(18)} ${v}`);
const rupees = (p) => `₹${(Number(p) / 100).toLocaleString("en-IN")}`;
const verdict = (v) => (v === "ALLOW" ? ok(v) : v === "STEP_UP" ? hm(v) : no(v));

console.log(bold("\nMCP client") + dim(`  ·  ${MERCHANT}/agent/mcp`));

step(1, "initialize", "the handshake, and the only instructions the model is given");
const init = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "Claude Desktop", version: "1.0.0" },
});
line("protocol", init.protocolVersion);
line("server", init.serverInfo.name);
line("session", `${sessionId.slice(0, 22)}…`);
console.log(dim(`\n   "${init.instructions}"`));

step(2, "tools/list", "what the model may call");
const { tools } = await rpc("tools/list");
for (const t of tools) line(t.name, dim(t.title));

step(3, "Try to buy with no permission", "registering and connecting grant nothing");
const noPerm = await tool("check_budget", { mandate_id: "mnd_nope" });
line("check_budget", no(noPerm.error));

step(4, "Ask the shopper for permission", "a URL for a human, and a reference to poll");
const asked = await tool("request_permission", {
  contact: "9999900011",
  categories: ["groceries", "household"],
  silent_threshold_paise: "50000",
});
line("granted", no(String(asked.granted)));
line("consent url", dim(asked.consent_url));

// A human does this on their phone. Here we drive it so the walkthrough completes.
const page = await (await fetch(asked.consent_url)).text();
const code = /<code>([0-9]{6})<\/code>/.exec(page)?.[1];
await fetch(`${MERCHANT}/consent/${asked.request_ref}/verify`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ code }).toString(),
});
line("human", dim(`entered ${code} on the consent page`));

step(5, "check_permission", "the model polls; it never reads the human's screen");
const granted = await tool("check_permission", { request_ref: asked.request_ref });
const mandate = granted.mandate_id;
line("granted", ok(String(granted.granted)));
line("mandate", ok(mandate));

step(6, "check_budget", "so it can size the basket before proposing one");
const budget = await tool("check_budget", { mandate_id: mandate });
line("left", rupees(budget.remaining_paise));
line("silent below", rupees(budget.silent_threshold_paise));

step(7, "catalog_search", "prices are the merchant's; the model cannot set one");
const found = await tool("catalog_search", { mandate_id: mandate, max_price_paise: "10000" });
for (const i of found.items) line(i.name, `${rupees(i.price_paise)}${i.in_scope ? "" : no("  out of scope")}`);

step(8, "get_quote then purchase", "first order here, so a human is asked");
const q1 = await tool("get_quote", {
  mandate_id: mandate,
  items: [{ sku: found.items[0].sku, quantity: 1 }],
});
line("quote", `${q1.quote_id.slice(0, 18)}…  ${rupees(q1.amount_paise)}`);

const buy1 = await tool("purchase", { quote_id: q1.quote_id, reason: "the usual basics" });
line("verdict", `${verdict(buy1.verdict)}  ${buy1.reason_code}`);
if (buy1.approval_url) {
  line("next", dim(buy1.next));
  await fetch(buy1.approval_url, { method: "POST" });
  line("human", ok("approved it"));
  await new Promise((r) => setTimeout(r, 2500));
}

step(9, "Buy again — silent", "under the threshold, nobody is interrupted");
const q2 = await tool("get_quote", {
  mandate_id: mandate,
  items: [{ sku: found.items[1].sku, quantity: 1 }],
});
const buy2 = await tool("purchase", { quote_id: q2.quote_id, reason: "and one more" });
line("verdict", `${verdict(buy2.verdict)}  ${buy2.reason_code}`);
line("amount", rupees(buy2.amount_paise));
await new Promise((r) => setTimeout(r, 2500));

step(10, "order_status", "processing means do not retry");
const status = await tool("order_status", { mandate_id: mandate, intent_id: buy2.intent_id });
line("state", status.state === "completed" ? ok(status.state) : hm(status.state));
line("reconciling", String(status.reconciling));

step(11, "Now misbehave", "the same session, told to do things it should not");

// Enough to clear the per-order cap, so this is a refusal rather than a step-up.
const big = await tool("get_quote", {
  mandate_id: mandate,
  items: found.items.map((i) => ({ sku: i.sku, quantity: 100 })),
});
const overCap = await tool("purchase", { quote_id: big.quote_id, reason: "buy 100 of everything" });
line(`${rupees(big.amount_paise)}`, `${no(overCap.reason_code)}  ${dim(overCap.next ?? "")}`);

const elec = await tool("catalog_search", { mandate_id: mandate, category: "electronics" });
if (elec.items.length > 0) {
  const bad = await tool("get_quote", {
    mandate_id: mandate,
    items: [{ sku: elec.items[0].sku, quantity: 1 }],
  });
  line("electronics", `${no(bad.reason_code ?? "refused")}  ${dim(bad.error ?? "")}`);
}

const replay = await tool("purchase", { quote_id: q2.quote_id, reason: "again" });
line("replay a quote", no(replay.error ?? replay.reason_code));

const stolen = sessionId;
sessionId = "not-a-real-session-token-at-all";
try {
  await tool("check_budget", { mandate_id: mandate });
  line("forged session", no("ACCEPTED — this is a bug"));
} catch (e) {
  line("forged session", no(String(e.message)));
}
sessionId = stolen;

console.log(`\n${bold("What the model never had")}`);
for (const s of [
  "a signing key — the kernel signs for the session, and signing grants nothing",
  "a price it could set",
  "a way to pay without a mandate a human granted",
  "a payment credential, anywhere",
]) console.log(`   ${dim("·")} ${s}`);
console.log(`\n${dim("   every decision above is in the merchant's ledger, with its reason code")}\n`);
