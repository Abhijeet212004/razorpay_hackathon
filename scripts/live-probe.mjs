/**
 * Is the Recurring Payments (custom/S2S) route provisioned on this account?
 *
 * Razorpay validates in this order: order id, then token, then amount, and only then
 * dispatches to the recurring-charge handler. So the question can only be answered with a
 * real confirmed token and a matching amount — anything earlier fails for a different
 * reason and tells you nothing.
 *
 *   "The requested URL was not found on the server"   the route is NOT provisioned
 *   a payment id, or any charge-specific error        the route IS provisioned
 *
 * Usage: node scripts/live-probe.mjs <test|live> <customer_id> <token_id> [amount_paise]
 * Reads keys from .env and prints no secret.
 */
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env", "utf8").split("\n")
    .map((l) => /^([A-Z_]+)=(.*)$/.exec(l)).filter(Boolean)
    .map((m) => [m[1], m[2]]),
);

const [mode = "test", customerId, tokenId, amountArg] = process.argv.slice(2);
const amount = Number(amountArg ?? 100);

if (!customerId || !tokenId) {
  console.error("  usage: node scripts/live-probe.mjs <test|live> <customer_id> <token_id> [amount_paise]");
  process.exit(1);
}

const id = mode === "live" ? env.RZP_LIVE_KEY_ID : env.RZP_KEY_ID;
const secret = mode === "live" ? env.RZP_LIVE_KEY_SECRET : env.RZP_KEY_SECRET;
if (!id || !secret) {
  console.error(`  no ${mode} keys in .env`);
  process.exit(1);
}
if (mode === "live" && !id.startsWith("rzp_live_")) {
  console.error("  RZP_LIVE_KEY_ID is not a live key — refusing");
  process.exit(1);
}
if (mode === "live") {
  console.log(`  LIVE MODE: if the route is provisioned this charges ₹${amount / 100} of real money.`);
}

const auth = "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
const api = async (path, body) => {
  const r = await fetch(`https://api.razorpay.com/v1${path}`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

console.log(`  probing ${mode} as ${id.slice(0, 12)}…`);

// An order costs nothing and moves nothing; it is a demand for payment, not a payment.
const order = await api("/orders", { amount, currency: "INR", customer_id: customerId });
if (!order.body.id) {
  console.error(`  could not create an order: ${order.body?.error?.description}`);
  process.exit(1);
}
console.log(`  order ${order.body.id} for ₹${amount / 100}`);

const charge = await api("/payments/create/recurring", {
  email: "shopper@example.com",
  contact: "+919876543210",
  amount,
  currency: "INR",
  order_id: order.body.id,
  customer_id: customerId,
  token: tokenId,
  recurring: true,
  description: "agentkit recurring probe",
});

const description = charge.body?.error?.description ?? "";
console.log(`  HTTP ${charge.status}: ${charge.body.id ?? description}\n`);

if (charge.body.id) {
  console.log(`  VERDICT: the route works — payment ${charge.body.id}, status ${charge.body.status}.`);
} else if (/not found on the server/i.test(description)) {
  console.log("  VERDICT: NOT provisioned. Everything else validated and dispatch still");
  console.log("           failed, so no parameter change or key swap will help. Only");
  console.log("           Razorpay support can enable Recurring Payments (custom/S2S).");
} else {
  console.log("  VERDICT: the route was reached — it failed on the charge itself, not on");
  console.log(`           dispatch. That is a provisioning-independent problem: ${description}`);
}
