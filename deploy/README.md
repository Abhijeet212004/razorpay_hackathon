# Deploying AgentKit

A single host running Docker. Two DNS names, one for the shop and one for the kernel.

Everything below is a command you run and a result you check. If a check does not produce
what it says, stop there rather than continuing: every later step assumes the earlier one
worked.

## What you need first

- A host with Docker and the compose plugin. 2 vCPU and 4 GB is comfortable; 2 GB is tight
  once Postgres and Mongo are both up.
- Ports 80 and 443 reachable from the internet. Let's Encrypt has to connect back in.
- Two DNS A records pointing at the host, for example `shop.example.com` and
  `kernel.example.com`. Create them before you start Caddy: a failed certificate challenge
  counts against a rate limit that resets slowly.
- Razorpay keys, and a webhook signing secret.

Check DNS has actually propagated before you go further:

```
dig +short shop.example.com
dig +short kernel.example.com
```

Both must print your host's address. `dig` returning nothing means the record has not
propagated yet, and no amount of retrying Caddy will fix it.

## 1. Get the code and configure it

```
git clone https://github.com/abhijeet212004/agentkit.git
cd agentkit
cp deploy/.env.production.example .env
sh deploy/generate-secrets.sh .env
```

That fills every password and shared secret with 32 random bytes. Now open `.env` and set
the things only you know: the two domains, `ACME_EMAIL`, your Razorpay keys, your SMTP
credentials, and `MERCHANT_ID`.

Check nothing was left behind:

```
grep -n "=generate$\|example.com" .env
```

Anything this prints is still a placeholder.

> **The one that bites.** `PUBLIC_BASE_URL` is what the kernel calls itself in the links it
> hands out: consent links, audit links, the pay page. If it still says `localhost`, every
> shopper gets a link that resolves to their own machine. It must be
> `https://` and your kernel domain.

## 2. Start it

```
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d
```

First boot applies migrations and seeds the catalog, which takes a minute or two. Watch it
settle:

```
docker compose ps
```

Every service should read `healthy`. `bootstrap` and `storefront-seed` are one-shot jobs
and will read `exited (0)` when they have done their work, which is correct.

If something is unhealthy, its logs say why:

```
docker compose logs kernel --tail=50
```

## 3. Check TLS came up

```
curl -sS https://kernel.example.com/health
```

Expect `{"ok":true,...}`. A certificate error here means the ACME challenge failed, and
almost always means DNS was not pointing here when Caddy first started. Fix the record,
then `docker compose restart caddy`.

Check the shop too:

```
curl -sS -o /dev/null -w '%{http_code}\n' https://shop.example.com/
```

Expect `200`.

## 4. Confirm nothing else is exposed

The overlay withdraws every published port but Caddy's. Verify that from somewhere other
than the host itself:

```
curl -sS --max-time 5 http://your.host.ip:55432 ; echo "exit=$?"
```

Expect a timeout or refusal. If Postgres answers, you are running the base compose file
without the overlay, and your database is on the internet. Stop and add the overlay.

## 5. Point Razorpay at it

In the Razorpay dashboard, under Settings, Webhooks, add:

```
https://kernel.example.com/agent/webhooks/razorpay
```

Subscribe to `payment.captured`, `payment.failed` and `refund.processed`. Put the signing
secret Razorpay shows you into `WEBHOOK_SECRET` in `.env`, then:

```
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d kernel worker
```

> A webhook is a notification, never an instruction. The kernel treats a capture claim as
> a reason to go and ask the provider what actually happened, and refuses the claim if the
> provider disagrees. A correctly signed webhook for a payment that was never captured
> does not move money.

## 6. Create your merchant account

Open `https://kernel.example.com/dashboard/signup` and register. You get an API key for
agents and a fulfilment token for your own backend.

Put the fulfilment token in `.env` as `AGENTKIT_FULFIL_TOKEN`, then restart the kernel and
your application so both hold the same value.

Check the pairing from the host:

```
curl -sS -H "x-agentkit-key: YOUR_API_KEY" https://kernel.example.com/agent/tools | head -c 200
```

A list of tools means the key works. `NO_CREDENTIAL` means it did not reach the header.

## 7. Prove the whole path

Install the SDK and run one purchase end to end.

```
npm install @agentkit/merchant
```

```js
const { AgentKit } = require("@agentkit/merchant");

const kit = new AgentKit({
  baseUrl: "https://kernel.example.com",
  apiKey: process.env.AGENTKIT_API_KEY,
});

const keys = AgentKit.generateKeyPair();
const { agentId } = await kit.registerAgent({ name: "Smoke Test", publicKey: keys.publicKey });
console.log("registered", agentId);
```

An agent id means registration works. It also means nothing else yet: until a shopper
grants a mandate, every purchase this agent proposes is refused with `MND-001`. That is
the system working, not a misconfiguration.

To get a mandate, start a consent request and approve it as a shopper:

```js
const consent = await kit.requestConsent({
  agentId,
  contact: "+919999999999",
  requestedScope: { merchants: ["mch_your_shop"], categories: ["groceries"], currency: "INR" },
  limits: {
    per_transaction_paise: "500000",
    cumulative_paise: "1500000",
    silent_threshold_paise: "50000",
    velocity_per_hour: 3,
  },
});
console.log(consent.consent_url);
```

Open that URL, enter the code, and the mandate is live. Then a purchase:

```js
const found = await kit.searchCatalog({ mandateId, query: "rice" });
const item = found.items.find((i) => i.in_scope);
const signedQuote = await kit.quote({ mandateId, items: [{ sku: item.sku, quantity: 1 }] });

const agent = kit.agent({ agentId, privateKey: keys.privateKey });
const decision = await agent.checkout({ mandateId, signedQuote, rationale: "smoke test" });
console.log(decision.verdict, decision.reason_code);
```

`ALLOW` and `OK-000` means the whole path works: signature verified, mandate checked, cap
reserved, decision written to the ledger.

## 8. Back up the database

The ledger is append-only and the chain is per mandate, which makes tampering detectable
but does nothing about a lost disk.

```
docker compose exec -T postgres pg_dump -U agentkit_owner agentkit | gzip > agentkit-$(date +%F).sql.gz
```

Put that on a schedule and somewhere other than this host.

## Upgrading

```
git pull
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build
```

Migrations are applied on boot by diffing the files against what the database has already
recorded, so a new migration is picked up and an old one is not reapplied.

## When something is wrong

| What you see | What it usually is |
| --- | --- |
| Certificate error on first boot | DNS was not pointing here when Caddy started. Fix the record, restart Caddy. |
| `MND-001` on every purchase | No live mandate for that agent. Expected until a shopper grants one. |
| `INT-001` on every purchase | Canonicalisation. Use the SDK rather than hand-rolling the signature. |
| `NO_CREDENTIAL` | The API key never reached the header. |
| Consent links point at localhost | `PUBLIC_BASE_URL` was not changed. |
| Every rate limit trips at once | `TRUST_PROXY` is off, so every request looks like it comes from Caddy. |
| Kernel unhealthy, Postgres fine | Migrations failed. `docker compose logs bootstrap`. |
