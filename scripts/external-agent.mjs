#!/usr/bin/env node
/**
 * An agent the merchant did not write.
 *
 * It starts with one thing: a merchant URL. Everything else — who this merchant is, what
 * tools exist, how to get permission, what is for sale — it discovers. It holds no
 * payment credential, no database access and no API key, and it is not on any allowlist.
 *
 * This is the case the trust kernel exists for. A merchant can decide to trust their own
 * assistant; they cannot decide to trust this one, and they do not have to.
 */
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";

const MERCHANT = process.env.MERCHANT_URL ?? "http://localhost:58080";

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const no = (s) => `\x1b[31m${s}\x1b[0m`;
const hm = (s) => `\x1b[33m${s}\x1b[0m`;

const rupees = (paise) => `₹${(Number(paise) / 100).toLocaleString("en-IN")}`;
const verdict = (v) => (v === "ALLOW" ? ok(v) : v === "STEP_UP" ? hm(v) : no(v));

function step(n, title, sub) {
  console.log(`\n${bold(`${n}. ${title}`)}`);
  if (sub) console.log(dim(`   ${sub}`));
}
function line(k, v) {
  console.log(`   ${k.padEnd(20)} ${v}`);
}

async function call(path, options = {}) {
  const res = await fetch(`${MERCHANT}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

// --- signing. The one hard part, and the reason the SDK exists -------------------------
function canonicalise(v) {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalise).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalise(v[k])}`).join(",")}}`;
}

const DER = Buffer.from("302e020100300506032b657004220420", "hex");

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });
  return {
    pub: Buffer.from(spki.subarray(spki.length - 32)),
    priv: Buffer.from(pkcs8.subarray(pkcs8.length - 32)),
  };
}

function signIntent(priv, intent) {
  const payload = {
    amount_paise: intent.amount_paise,
    basket_hash: intent.basket_hash,
    expires_at: intent.expires_at,
    intent_id: intent.intent_id,
    mandate_id: intent.mandate_id,
    merchant_id: intent.merchant_id,
    nonce: intent.nonce,
    quote_id: intent.quote_id,
    rationale: intent.rationale,
    type: intent.type,
  };
  return sign(null, Buffer.from(canonicalise(payload), "utf8"), {
    key: Buffer.concat([DER, priv]),
    format: "der",
    type: "pkcs8",
  }).toString("hex");
}

async function buy(me, mandateId, items, why) {
  const quoted = await call("/agent/quote", {
    method: "POST",
    body: JSON.stringify({ mandate_id: mandateId, items }),
  });
  if (quoted.status !== 200) return { refused: quoted.body };

  const q = quoted.body.quote;
  const intent = {
    intent_id: `int_${randomUUID()}`,
    type: "purchase",
    mandate_id: mandateId,
    quote_id: q.quote_id,
    merchant_id: q.merchant_id,
    amount_paise: q.amount_paise,
    basket_hash: q.basket_hash,
    rationale: why,
    nonce: randomBytes(16).toString("hex"),
    expires_at: new Date(Date.now() + 120_000).toISOString(),
  };

  const done = await call("/agent/acp/checkout", {
    method: "POST",
    body: JSON.stringify({
      signedIntent: { intent, agent_id: me.id, signature: signIntent(me.priv, intent) },
      signedQuote: quoted.body,
    }),
  });
  return { quote: q, decision: done.body, intent };
}

// ======================================================================================
console.log(bold("\nAn agent the merchant did not write") + dim(`\n  it knows only: ${MERCHANT}`));

step(1, "Discover the merchant", "one well-known URL, no partnership call, no key exchange");
const manifest = (await call("/.well-known/agent-commerce.json")).body;
line("merchant", manifest.merchant_id);
line("transports", manifest.transports.join(", "));
line("tools", manifest.tools);

step(2, "Read the tool surface", "what may I call, and what does each call cost");
const tools = (await call("/agent/tools")).body;
for (const t of tools.tools) line(t.class, t.name);

step(3, "Register", "identity only — this grants nothing at all");
const keys = keypair();
const me = {
  id: (await call("/agent/register", {
    method: "POST",
    body: JSON.stringify({ name: "An External Agent", public_key: keys.pub.toString("hex") }),
  })).body.agent_id,
  priv: keys.priv,
};
line("agent_id", me.id);

step(4, "Try to buy before permission", "the whole point of registering being free");
const early = await buy(me, "mnd_does_not_exist", [{ sku: "x", quantity: 1 }], "trying it on");
line("refused", no(early.refused?.error ?? early.decision?.reason_code ?? "?"));

step(5, "Ask a human for permission", "a reference comes back, never a grant");
const consent = (await call("/consent/request", {
  method: "POST",
  body: JSON.stringify({
    agent_id: me.id,
    contact: "9999900007",
    requested_scope: { merchants: [manifest.merchant_id], categories: ["groceries", "household"], currency: "INR" },
    limits: {
      per_transaction_paise: "500000",
      cumulative_paise: "1500000",
      silent_threshold_paise: "50000",
      velocity_per_hour: 10,
    },
  }),
})).body;
line("consent page", consent.consent_url);

const page = await (await fetch(consent.consent_url)).text();
const code = /<code>([0-9]{6})<\/code>/.exec(page)?.[1];
line("otp", dim(`${code} — shown on screen, demo number`));

// The human completes the flow. In a real deployment they do this on their phone.
await fetch(`${MERCHANT}/consent/${consent.request_ref}/verify`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ code }).toString(),
});

// The agent asks whether it was permitted. It never reads the human's screen.
const outcome = (await call(`/consent/${consent.request_ref}/status`)).body;
const mandateId = outcome.mandate_id;
line("granted", outcome.granted ? ok("yes") : no("no"));
line("mandate", ok(mandateId));

step(6, "Find something to buy", "prices are the merchant's; the agent never supplies one");
const found = (await call("/agent/catalog/search", {
  method: "POST",
  body: JSON.stringify({ mandate_id: mandateId, max_price_paise: "10000" }),
})).body;
for (const i of found.items) line(i.name, `${rupees(i.price_paise)} ${i.in_scope ? "" : no("out of scope")}`);

step(7, "Check the budget before spending it", "so it can split an order rather than be refused");
const budget = (await call(`/agent/mandate/${mandateId}`)).body;
line("left this window", rupees(budget.remaining_paise));
line("silent below", rupees(budget.silent_threshold_paise));

step(8, "Buy", "first order at this merchant, so a human is asked");
const first = await buy(me, mandateId, [{ sku: found.items[0].sku, quantity: 1 }], "getting the basics");
line("verdict", `${verdict(first.decision.verdict)}  ${first.decision.reason_code}`);
if (first.decision.approval_url) {
  line("approval", dim(first.decision.approval_url));
  await fetch(first.decision.approval_url, { method: "POST" });
  line("approved", ok("a human said yes"));
  await new Promise((r) => setTimeout(r, 2500));
}

step(9, "Buy again — now it is silent", "under the threshold, no interaction at all");
const second = await buy(me, mandateId, [{ sku: found.items[1].sku, quantity: 1 }], "and one more");
line("verdict", `${verdict(second.decision.verdict)}  ${second.decision.reason_code}`);
line("amount", rupees(second.quote.amount_paise));
if (second.decision.approval_url) {
  // Silence is earned by a settled first order at this merchant. On the live rail nobody
  // has paid one yet, so STP-002 correctly asks again rather than assuming.
  line("why not silent", dim("no settled order at this merchant yet — STP-002 still applies"));
  await fetch(second.decision.approval_url, { method: "POST" });
  line("approved", ok("a human said yes"));
}
await new Promise((r) => setTimeout(r, 2500));

step(10, "Track it", "processing means we do not yet know — never retry it");
const tracked = await call("/agent/orders/status", {
  method: "POST",
  body: JSON.stringify({ mandate_id: mandateId, intent_id: second.intent.intent_id }),
});
if (tracked.status === 404) {
  line("state", hm("no order — the intent was never authorised to become one"));
} else {
  const status = tracked.body;
  line("state", status.state === "completed" ? ok(status.state) : hm(status.state));
  line("reconciling", String(status.reconciling));
}

step(11, "Reorder", "the same items, priced afresh — yesterday's approval buys nothing today");
const again = (await call("/agent/orders/reorder", {
  method: "POST",
  body: JSON.stringify({ mandate_id: mandateId, intent_id: second.intent.intent_id }),
})).body;
line("items", JSON.stringify(again.items));

step(12, "Now misbehave", "the same agent, told to do something it should not");
const overCap = await buy(me, mandateId, [{ sku: found.items[0].sku, quantity: 400 }], "buy 400 units");
line("400 units", no(`${overCap.decision?.reason_code ?? overCap.refused?.reason_code ?? "refused"}`));

const outOfScope = (await call("/agent/catalog/search", {
  method: "POST",
  body: JSON.stringify({ mandate_id: mandateId, category: "electronics" })
})).body;
if (outOfScope.items.length > 0) {
  const charger = await buy(me, mandateId, [{ sku: outOfScope.items[0].sku, quantity: 1 }], "a charger");
  line("electronics", no(charger.refused?.reason_code ?? charger.decision?.reason_code ?? "refused"));
}

const replay = await call("/agent/acp/checkout", {
  method: "POST",
  body: JSON.stringify({
    signedIntent: {
      intent: second.intent,
      agent_id: me.id,
      signature: signIntent(me.priv, second.intent),
    },
    signedQuote: { quote: second.quote, kid: "x", signature: "00" },
  }),
});
line("replay a purchase", no(replay.body.reason_code));

console.log(`\n${bold("What it never had")}`);
for (const s of ["a payment credential", "database access", "an API key", "a place on any allowlist"]) {
  console.log(`   ${dim("·")} ${s}`);
}
console.log(`\n${dim("   every decision above is in the merchant's ledger, with its reason code")}\n`);
