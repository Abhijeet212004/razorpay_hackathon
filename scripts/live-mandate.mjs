/**
 * A live-mode mandate, end to end, outside the kernel.
 *
 * Deliberately standalone: the running stack keeps its test credentials, so nothing in
 * the demo system can move real money while this runs. The only thing that touches live
 * Razorpay is this script and the page it serves.
 *
 * It creates a customer and a ₹1 registration order, serves a Checkout page for the
 * shopper to authorise on their own card, waits for the bank to confirm a token, and then
 * asks the only question worth asking: does the recurring-charge route exist here?
 *
 * Usage: node scripts/live-mandate.mjs [upi|card] [max_paise] [port]
 *
 * UPI Autopay registers instantly but NPCI requires a pre-debit notification 24 hours
 * before each debit, so a charge straight afterwards is expected to be refused for that
 * reason — which is itself informative: it means the route exists.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env", "utf8").split("\n")
    .map((l) => /^([A-Z_]+)=(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]),
);

// Test mode by default; pass --live to use the live credentials instead.
const LIVE = process.argv.includes("--live");
const KEY = LIVE ? env.RZP_LIVE_KEY_ID : env.RZP_KEY_ID;
const SECRET = LIVE ? env.RZP_LIVE_KEY_SECRET : env.RZP_KEY_SECRET;
const METHOD = process.argv[2] === "card" ? "card" : "upi";
const MAX_PAISE = Number(process.argv[3] ?? 100000);   // the ceiling the bank records
const PORT = Number(process.argv[4] ?? 59000);
const REGISTER_PAISE = 100;                            // ₹1, real

if (!KEY || !SECRET) {
  console.error("  add RZP_LIVE_KEY_ID and RZP_LIVE_KEY_SECRET to .env first");
  process.exit(1);
}
if (LIVE && !KEY.startsWith("rzp_live_")) {
  console.error(`  RZP_LIVE_KEY_ID does not look live (${KEY.slice(0, 9)}…) — refusing`);
  process.exit(1);
}

const auth = "Basic " + Buffer.from(`${KEY}:${SECRET}`).toString("base64");
const api = async (path, body) => {
  const r = await fetch(`https://api.razorpay.com/v1${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

console.log(`\n  ${LIVE ? "LIVE MODE" : "TEST MODE"} — key ${KEY.slice(0, 13)}…`);
console.log(`  ₹${REGISTER_PAISE / 100} ${LIVE ? "will actually be charged" : "is simulated"} to authorise the mandate.`);
console.log(`  method: ${METHOD}   ceiling recorded with the bank: ₹${MAX_PAISE / 100}\n`);

// A fresh customer each run. fail_existing:"0" returns the existing one for a repeated
// email, which would inherit whatever state a previous failed mandate left behind.
const stamp = Date.now().toString(36);
const customer = await api("/customers", {
  name: "AgentKit Shopper", email: `shopper+${stamp}@example.com`,
  contact: "+918263811035", fail_existing: "0",
});
if (!customer.body.id) {
  console.error(`  customer failed: ${customer.body?.error?.description}`);
  process.exit(1);
}
console.log(`  customer  ${customer.body.id}`);

const order = await api("/orders", {
  amount: REGISTER_PAISE, currency: "INR", customer_id: customer.body.id, method: METHOD,
  token: {
    max_amount: MAX_PAISE,
    expire_at: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
    frequency: "as_presented",
  },
  notes: { purpose: "agentkit_live_probe" },
});
if (!order.body.id) {
  console.error(`  order failed: ${order.body?.error?.description}`);
  process.exit(1);
}
console.log(`  order     ${order.body.id}\n`);

const page = `<!doctype html><meta charset="utf-8">
<title>Authorise autopay</title>
<style>body{font:16px system-ui;margin:0;display:grid;place-items:center;height:100vh}
main{max-width:380px;text-align:center}button{font:inherit;font-weight:600;padding:14px 22px;
border:0;border-radius:10px;background:#0b5;color:#fff;cursor:pointer}
p{color:#666}</style>
<main>
<h2>Authorise autopay</h2>
<p>₹1 will be charged now to register the mandate. Your bank will allow up to
₹${MAX_PAISE / 100} afterwards, and you can revoke it at any time.</p>
${METHOD === "upi" ? `<input id="vpa" placeholder="yourname@okhdfcbank"
  style="font:inherit;padding:12px;width:100%;box-sizing:border-box;border:1px solid #ccc;
  border-radius:8px;margin-bottom:10px;text-align:center">
<p style="font-size:13px">Type your UPI ID and the request goes straight to your app,
instead of relying on the QR handoff.</p>` : ""}
<button id="go">Authorise with ${METHOD === "upi" ? "UPI" : "a card"}</button>
<p id="s"></p>
</main>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>
document.getElementById("go").onclick = function () {
  var s = document.getElementById("s");
  new Razorpay({
    key: ${JSON.stringify(KEY)},
    order_id: ${JSON.stringify(order.body.id)},
    customer_id: ${JSON.stringify(customer.body.id)},
    recurring: "1",
    name: "AgentKit",
    description: "Authorise autopay",
    prefill: ${METHOD === "upi"
      ? `(function () {
          var v = document.getElementById("vpa").value.trim();
          return v ? { method: "upi", vpa: v } : { method: "upi" };
        })()`
      : `{ method: "card" }`},
    handler: function () { s.textContent = "Authorised. Return to the terminal."; },
    modal: { ondismiss: function () { s.textContent = "Cancelled."; } },
  }).open();
};
</script>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(page);
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
console.log(`  Open  http://localhost:${PORT}  and authorise with your Mastercard.`);
console.log(`  Waiting for your bank to confirm the token...\n`);

let token = null;
for (let attempt = 0; attempt < 150 && token === null; attempt += 1) {
  await new Promise((r) => setTimeout(r, 4000));
  const tokens = await api(`/customers/${customer.body.id}/tokens`);
  const found = (tokens.body.items ?? []).find((t) => t.recurring);
  if (found) token = found;
  else process.stdout.write(".");
}
server.close();
console.log();

if (token === null) {
  console.log("\n  No token appeared. Nothing was authorised, so nothing recurring exists.");
  process.exit(1);
}

const card = token.card ?? {};
console.log(`\n  token     ${token.id}`);
console.log(`  card      ${card.network} ${card.type} ****${card.last4}`);
console.log(`  ceiling   ₹${(token.max_amount ?? 0) / 100}`);
console.log(`  status    ${token.recurring_details?.status}\n`);
console.log(`  Now probe the recurring route:`);
console.log(`    node scripts/live-probe.mjs live ${customer.body.id} ${token.id} 100\n`);
console.log(`  And when you are done, revoke it:`);
console.log(`    node scripts/live-revoke.mjs ${customer.body.id} ${token.id}\n`);
