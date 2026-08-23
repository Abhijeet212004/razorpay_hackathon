# Architecture

Three plates in `plates/` are the authoritative pictures. This is the written version.

## Components

### Client surfaces — untrusted
- **Buyer agent** — MCP client, hand-written tool loop, frozen-plan SHA-256 computed *before*
  any catalog read, Ed25519 keystore. Separate process, separate environment, no Razorpay
  secret present.
- **Merchant chat surface** — optional; same MCP endpoint, same gate.

### Merchant/operator surfaces
- **Consent & step-up** — two server-rendered pages served by the kernel. Rendered only from
  server-held state: amount and basket from the signed quote, merchant identity resolved from
  the allowlist. Nothing the agent supplied appears.
- **Audit console** — reads Postgres directly under `agentkit_console`, RLS-scoped.

### HTTP edge — added by `guard.mount(app, "/agent")` or an nginx route to the sidecar
```
GET   /.well-known/agent-commerce.json   discovery manifest
GET   /agent/catalog.json                signed product feed (JCS + Ed25519, kid)
POST  /agent/mcp                         MCP transport, 6 declared tools
POST  /agent/acp/checkout                ACP-shaped REST for non-MCP buyers
POST  /agent/webhooks/razorpay           HMAC-SHA256 verified, event-id deduplicated
GET   /agent/audit/:intent_id            replayable trace, redacted payloads
GET   /agent/approve/:challenge          step-up, server state only
```
Edge middleware: token-bucket limiter (30/min per agent, 10/min per mandate) → `LMT-005`;
Zod validation at every boundary; `taint()` tagging outside content before the model sees it.
`guard.requireMandate()` responds on DENY/STEP_UP having already written the ledger entry — so
a handler cannot forget to log a denial.

### Trust kernel — ten services, deterministic
`identity` (OTP adapter, agent registry, signing_keys with kid) · `mandate` (JWS/VC issue,
scope, revoke under the row lock) · `quote` (server-side pricing, binds mandate_id and
basket_hash, short TTL, single use) · `policy` (YAML → typed predicate union, deterministic
fold, `evaluated[]` trace, fail-closed) · `executor` (sole credential holder, idempotency key,
egress allowlist) · `taint` (branded types) · `verifier` (downgrade-only, outside the txn) ·
`ledger` (JCS → SHA-256, chain per mandate) · `reconciler` (HMAC verify → dedupe →
`orders.fetch` → transition) · `consent renderer` (the two human pages).

### Worker — pg-boss on the same Postgres
`reconcile-ambiguous` · `compensate-revoked` · `verify-chain + anchor` · `expire-mandates` ·
**`release-stale-reservations`** (ADR-003 requires this; without it an abandoned hold consumes
cap forever).

### Data layer
`mandates` (FOR UPDATE lock target) · `ledger` (append-only, RLS FORCE, per-mandate chain,
`UNIQUE (chain_id, prev_hash)`) · `ledger_anchor` · **`reservations`** · `quotes` · `orders` ·
`agents` · `auth_events` · `signing_keys` · `webhook_events` (PK on `provider_event_id`) ·
`pseudonym_map` (mutable — the erasure target) · `pgboss.*`.

## Data contracts

Zod in each module's `*.validation.ts` is the single source of truth; both the runtime validator and the
TypeScript type come from one definition.

- **Mandate** — subject (pseudonym + auth_event with `max_age`), agent (id, pubkey,
  attestation), scope (merchants allowlist keyed on id, categories, currency), limits
  (per_transaction, cumulative, window, velocity_per_hour, silent_threshold), validity,
  revocation, chain, signature with `kid`.
- **Quote** — `quote_id`, **`mandate_id`**, merchant, `basket_hash`, `amount_paise`, expiry,
  signature with `kid`.
- **Intent** — id, type, mandate_id, quote_id, merchant_id, amount_paise, basket_hash,
  `rationale` (typed `Tainted<string>`, display only), nonce, expiry, signature.
- **Decision** — verdict, reason_code, `evaluated[]` with observed beside bound, idempotency key.
- **Ledger entry** — chain_id, seq, prev_hash, kind, merchant_id, ref, `payload_redacted`, hash.

Kinds: `MANDATE_ISSUED` · `INTENT` · `DECISION` · `RESERVATION` · `API_CALL` · `WEBHOOK` ·
`EXECUTION_RESULT` · `RELEASE` · `RECONCILE` · `REFUND` · `ANCHOR`.

## The hash chain

```
canonical = JCS(payload)                      RFC 8785, deterministic key order
hash      = SHA256(prev_hash ‖ canonical)
entry[N].prev_hash == entry[N-1].hash         genesis prev_hash = 32 zero bytes
```
Verification recomputes from raw rows. `agentkit verify --mandate <id>` gives a reviewer a check
that does not depend on our UI.

## Failure handling

`AUTHORISED → SUBMITTED → CAPTURED | FAILED`, and `SUBMITTED → AMBIGUOUS` on timeout with no
terminal webhook. **There is no edge from `AMBIGUOUS` back to `SUBMITTED`** — the missing arrow
is the double charge that never happens. Ambiguity is resolved by reading, never by retrying,
and the reservation stays `held` throughout.

## Protocol position

MCP primary (Razorpay ships their own). ACP-shaped endpoint so non-MCP buyers can transact.
AP2-shaped mandate model, cited not implemented. UCP's signed feed and well-known manifest
borrowed. x402 deliberately out of scope. UAP-shaped throughout so the eventual swap is a rail
change, not a redesign — default limits are set to the exact UAP figures (₹5,000 / ₹15,000).
