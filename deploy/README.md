<p align="center">
  <img src="../docs/plates/razorpay-banner.svg" alt="Razorpay" width="360">
</p>

# Deploying AgentKit

One host running Docker, two DNS names, and about twenty minutes.

Everything below is a command you run and a result you check. If a check does not produce
what it says, stop there — every later step assumes the earlier one worked.

This is the procedure that produced the live deployment at `kernel.asparsh.com`, corrected
against what actually went wrong the first time.

---

## What the stack needs

Measured, not estimated. The whole system idles at **under 400 MiB**:

| | |
|---|---|
| kernel | 21 MiB |
| web | 18 MiB |
| executor | 21 MiB |
| worker | 33 MiB |
| storefront | 56 MiB |
| postgres | 44 MiB |
| mongo | 203 MiB |
| **total** | **396 MiB** |

So a 1 GB instance is enough to *run* it. What 1 GB is not enough for is **building** the
images — a React build wants far more. Build elsewhere and ship the images; see
[Getting the images there](#getting-the-images-there).

**Disk is the constraint people miss.** The images come to roughly 2 GB (mongo alone is 1.1
GB). A default 8 GB root volume with ~4 GB free will fail partway through `docker load` with
`no space left on device`. Give it **20 GB or more**.

## Before you start

- A host with Docker and the compose plugin. **1 GB RAM works** with swap; 2 GB is
  comfortable.
- **20 GB+ disk.**
- Ports **80 and 443** reachable from the internet. On AWS that means a security group rule;
  on Oracle Cloud it also means an ingress rule, which is the step everyone forgets.
- Two DNS **A** records pointing at the host, e.g. `shop.example.com` and
  `kernel.example.com`.
- Razorpay keys, and a webhook signing secret.

Check DNS has propagated before going further:

```bash
dig +short shop.example.com
dig +short kernel.example.com
```

Both must print your host's address. If the public resolvers lag, ask the authoritative
server directly — Let's Encrypt queries those, not your ISP's cache:

```bash
dig +short shop.example.com @ns01.domaincontrol.com
```

---

## 1 · Prepare the host

```bash
# Swap first. 1 GB with no swap drops SSH under load.
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
```

Log out and back in so the group applies.

> **If your distribution has no Docker repo yet** — Ubuntu 26.04 at the time of writing —
> the 24.04 (`noble`) repository works.

---

## 2 · Get the code and configure it

```bash
git clone https://github.com/Abhijeet212004/razorpay_hackathon.git agentkit
cd agentkit
cp deploy/.env.production.example .env
sh deploy/generate-secrets.sh .env
```

That fills every password and shared secret with 32 random bytes. Now open `.env` and set
what only you know: the two domains, `ACME_EMAIL`, your Razorpay keys, SMTP, `MERCHANT_ID`.

Check nothing was left behind:

```bash
grep -n "=generate$\|example.com" .env
```

Anything it prints is still a placeholder.

> **The one that bites.** `PUBLIC_BASE_URL` is what the kernel calls itself in every link it
> hands out — consent links, audit links, the pay page. If it still says `localhost`, every
> shopper receives a link that resolves to their own machine. It must be `https://` and your
> kernel domain.

**Start with test keys.** Prove the whole path, then swap to live. There is no reason to risk
real money on a first boot.

---

## 3 · Getting the images there

On a small host, do not build. Build on your own machine and ship the result.

**The architecture trap:** if you build on an Apple Silicon Mac you produce **arm64** images,
and an x86 server answers `exec format error`. Cross-build explicitly:

```bash
docker buildx build --platform linux/amd64 -t ghcr.io/<you>/agentkit:latest -f Dockerfile --load .
docker buildx build --platform linux/amd64 -t agentkit-storefront:local -f storefront/Dockerfile --load .

docker image inspect ghcr.io/<you>/agentkit:latest --format '{{.Architecture}}'   # must say amd64
```

Then either push to a registry, or ship them directly:

```bash
docker save ghcr.io/<you>/agentkit:latest agentkit-storefront:local | gzip -1 > images.tar.gz
scp images.tar.gz user@host:/tmp/
ssh user@host 'gunzip -c /tmp/images.tar.gz | docker load && rm /tmp/images.tar.gz'
```

> On a flaky link, a single 85 MB stream over SSH fails often. Split it and verify:
> `split -b 8m images.tar.gz part.` then `scp` each part, `cat part.* > images.tar.gz` on the
> host, and compare `sha256sum` both ends before loading.

Copy the repository itself with `rsync -az --exclude .git --exclude node_modules ./ user@host:~/agentkit/`
if you would rather not commit before deploying.

---

## 4 · Start it

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d
```

The overlay changes four things: Caddy terminates TLS and is the **only** thing listening on
the internet; every other published port is withdrawn, so Postgres and Mongo become reachable
only inside the compose network; `TRUST_PROXY` is on, because the client address now arrives
in a header; and restart policies are set so a reboot brings the system back.

First boot applies migrations and seeds the catalog. Watch it settle:

```bash
docker compose ps
```

Everything should read `healthy`. `bootstrap` and `storefront-seed` are one-shot jobs and
correctly read `exited (0)`.

```
[bootstrap] schema now at 20 migrations
[seed] 3 mandates, 45 decisions, 3 chains anchored
[bootstrap] ready
```

If something is unhealthy, its logs say why: `docker compose logs kernel --tail=50`.

**Tight on memory?** `replay` is the fake rail and `buyer-agent` is a demo harness. Neither is
needed in production:

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml stop replay buyer-agent
```

---

## 5 · Check TLS came up

```bash
curl -sS https://kernel.example.com/health
curl -sS -o /dev/null -w '%{http_code}\n' https://shop.example.com/
```

Expect `{"ok":true,...}` and `200`.

A certificate error almost always means DNS was not pointing here when Caddy first started.
Fix the record, then `docker compose restart caddy`. A failed ACME challenge counts against a
rate limit that resets slowly, so check DNS *before* retrying.

Confirm nothing else is exposed, from somewhere other than the host:

```bash
curl -sS --max-time 5 http://your.host.ip:55432 ; echo "exit=$?"
```

Expect a timeout or refusal. If Postgres answers, you are running the base compose file
without the overlay and your database is on the internet.

---

## 6 · Point Razorpay at it

Dashboard → **Settings → Webhooks**:

```
https://kernel.example.com/agent/webhooks/razorpay
```

Subscribe to `payment.captured`, `payment.failed` and `refund.processed`. Put the signing
secret into `WEBHOOK_SECRET` in `.env`, then:

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d kernel worker
```

Verify it discriminates:

```bash
curl -s -o /dev/null -w 'unsigned %{http_code}\n' -X POST \
  https://kernel.example.com/agent/webhooks/razorpay \
  -H 'content-type: application/json' -d '{"event":"payment.captured"}'
```

Expect `401`.

> A webhook is a **notification, never an instruction**. A correctly signed capture claim is
> treated as a reason to go and ask the provider what actually happened, and refused if the
> provider disagrees. A valid signature for an unpaid order does not move money.

---

## 7 · Create your merchant account

Open `https://kernel.example.com/dashboard/signup`. You get an `ak_…` API key for agents and
an `aft_…` fulfilment token for your own backend.

Put the fulfilment token in `.env` as `AGENTKIT_FULFIL_TOKEN` and restart the kernel and your
application, so both hold the same value.

```bash
curl -sS -H "x-agentkit-key: YOUR_KEY" https://kernel.example.com/agent/tools | head -c 200
```

A list of tools means the key works. `unauthorised` means it never reached the header.

> **Single-tenant note.** The worker syncs the product catalog only for the merchant named in
> `MERCHANT_ID`. If you onboard additional merchants through the dashboard on this
> deployment, they will have empty catalogs. Multi-tenant catalog sync is per-merchant
> configuration the worker does not yet iterate.

---

## 8 · Prove the whole path

```bash
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

An agent id means registration works, and nothing else yet — until a shopper grants a
mandate, every purchase is refused with `MND-001`. That is the system working.

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

All four limits are required. Open the URL, approve as a shopper, then:

```js
const found = await kit.searchCatalog({ mandateId, query: "rice" });
const item = found.items.find((i) => i.in_scope);
const signedQuote = await kit.quote({ mandateId, items: [{ sku: item.sku, quantity: 1 }] });

const agent = kit.agent({ agentId, privateKey: keys.privateKey });
const decision = await agent.checkout({ mandateId, signedQuote, rationale: "smoke test" });
console.log(decision.verdict, decision.reason_code);
```

`ALLOW` and `OK-000` means the whole path works. A `STEP_UP` is also success — it means the
policy engine wants a human, and `decision.approval_url` is where they go.

---

## 9 · Back it up

The ledger is append-only and the chain is per mandate, which makes tampering detectable and
does nothing about a lost disk.

```bash
docker compose exec -T postgres pg_dump -U agentkit_owner agentkit | gzip > agentkit-$(date +%F).sql.gz
```

Put that on a schedule, and somewhere other than this host.

---

## Upgrading

```bash
git pull
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build
```

Migrations are applied on boot by diffing the files against what the database has already
recorded, so a new one is picked up and an old one is not reapplied.

> If you ship a rebuilt image under the **same tag**, compose will not recreate the container
> — the service definition has not changed. Force it:
> `docker compose -f ... up -d --force-recreate kernel web worker executor`

---

## When something is wrong

| What you see | What it usually is |
|---|---|
| `exec format error` | arm64 images on an x86 host. Cross-build with `--platform linux/amd64`. |
| `no space left on device` during load | Root volume too small. 20 GB minimum. |
| Certificate error on first boot | DNS was not pointing here when Caddy started. Fix, then restart Caddy. |
| Container still old after deploying a new image | Same tag, so compose skipped it. Add `--force-recreate`. |
| `MND-001` on every purchase | No live mandate for that agent. Expected until a shopper grants one. |
| `INT-001` on every purchase | Canonicalisation. Use an SDK rather than hand-rolling the signature. |
| `unauthorised` | The API key never reached the header. |
| Consent links point at localhost | `PUBLIC_BASE_URL` was not changed. |
| Consent page 404s for a shopper | Wrong `MERCHANT_AUTHORIZE_URL` — it must be the rendered page, not the JSON API behind it. |
| Every rate limit trips at once | `TRUST_PROXY` is off, so every request looks like it comes from Caddy. |
| Dashboard times are hours out | Set `DISPLAY_TIME_ZONE`. Defaults to `Asia/Kolkata`. |
| Kernel unhealthy, Postgres fine | Migrations failed. `docker compose logs bootstrap`. |
| SSH drops during large transfers | Memory pressure. Add swap, stop `replay` and `buyer-agent`, split the transfer. |
