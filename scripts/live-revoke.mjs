/** Deletes a live token, so the mandate cannot be charged again. */
import { readFileSync } from "node:fs";
const env = Object.fromEntries(
  readFileSync(".env", "utf8").split("\n")
    .map((l) => /^([A-Z_]+)=(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]),
);
const [customerId, tokenId] = process.argv.slice(2);
if (!customerId || !tokenId) {
  console.error("  usage: node scripts/live-revoke.mjs <customer_id> <token_id>");
  process.exit(1);
}
const auth = "Basic " + Buffer.from(`${env.RZP_LIVE_KEY_ID}:${env.RZP_LIVE_KEY_SECRET}`).toString("base64");
const r = await fetch(
  `https://api.razorpay.com/v1/customers/${customerId}/tokens/${tokenId}`,
  { method: "DELETE", headers: { Authorization: auth } },
);
console.log(`  revoke -> ${r.status} ${await r.text()}`);
