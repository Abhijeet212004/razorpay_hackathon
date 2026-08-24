# AgentKit for Razorpay — Project Context

Read this file first, every session, then the rulings in `docs/`.
Detail lives in `docs/`. Precedence: **`rulings-003` > `rulings-002` > `rulings-001` > this file >
everything else.**
Where any two disagree, tell me rather than silently picking one.

The three SVG plates in `docs/plates/` are **stale** — they predate ADR-003 and ADR-004 and draw
the settled-only cap query and the verifier inside the lock. Do not treat them as normative.

---

## NON-NEGOTIABLE INVARIANTS

Never weaken, remove, or work around any of these to make something pass. If one appears to
block progress, stop and ask.

These cite the `INV-NN` table in `docs/security-invariants.md`, which is the **only** invariant
namespace. Grep-able enforcement comments use those IDs: `// INV-05: …`.

- **The model can propose. It can never authorise.** Authorisation is deterministic code. `INV-01`
- **A model may cause DENY, never ALLOW** — and a model being unavailable may never cause ALLOW
  either. `INV-17`
- **Only the executor service holds a Razorpay credential.** It is absent — not unused, absent —
  from every other process. `INV-02`
- **Spend caps count reserved (authorised-but-unsettled) amounts, not only settled ones.**
  Settled-only accounting is a concurrency vulnerability. `INV-05`, ADR-003
- **The cap check and the reservation write are one atomic unit**, under `READ COMMITTED` holding
  `SELECT … FOR UPDATE` on the mandate row. `INV-05`, ADR-016
- **No external model or API call while the mandate row lock is held.** `INV-19`, ADR-004
- **Executed amount equals the signed quote amount exactly**, and the quote names its mandate.
  `INV-06`, `INV-14`
- **Every money-moving call is idempotent**, keyed `sha256(intent_id)`. `INV-04`
- **The ledger is append-only from every role.** `UPDATE`/`DELETE` revoked. `INV-11`
- **Merchant isolation is enforced by PostgreSQL RLS with `FORCE`**, not by application code.
  `INV-21`
- **Replay mode runs with zero external credentials.** Judges will run this. `INV-22`
- **Live mode uses real Razorpay Test Mode, and the UI always shows the active mode.** `INV-23`
- **Every invariant has one enforcement point and one test that fails if you delete it.**

---

## What this is

An agentic-commerce trust layer for Razorpay. It lets third-party AI agents transact with a
merchant while making it structurally impossible for the AI to move money on its own.

**The thesis:** the trust boundary sits *below* the model, not around it. A fully compromised
agent gets one transaction, at an allowlisted merchant, under the silent threshold, fully
logged, and reversible — not because the model was defended, but because it was never trusted.

## Architecture in one diagram

```
User ──► Buyer agent (untrusted, no credentials)
             │  signed Intent
             ▼
      HTTP edge  ─── rate limit · Zod · taint tagging
             │
   ═══════ TRUST BOUNDARY ═══════   no key crosses upward
             │
      Trust kernel (deterministic, no model on the decision path)
        identity · mandate · quote · policy · taint
        verifier adapter · ledger · reconciler · consent+step-up pages
             │                              │
      PostgreSQL                      executor service  ─── no ingress · sole credential
        append-only ledger                  │
        RLS FORCE · row locks         Razorpay Test Mode
```

The plates in `docs/plates/` are stale — see the note at the top of this file. `docs/architecture.md`
plus `docs/rulings-001.md` are the current picture.

## The authorisation sequence — get this exactly right

This is the heart of the system. Order matters, and two steps are outside the transaction
deliberately.

```
1. stateless checks     signature · nonce FORMAT · expiry · taint · quote signature
                        · quote.mandate_id == intent.mandate_id · amount == quote.amount
                        · edge already applied the request-rate limit (LMT-005)
2. blind verifier       OUTSIDE any transaction. may only downgrade ALLOW → DENY.
                        memoised — not re-run on retry.
                        timeout: DENY SYS-002 above the silent threshold; below it, proceed
                        and write a skip entry. never grants.
3. BEGIN READ COMMITTED         lock_timeout 3s · statement_timeout 5s
4. SELECT … FROM mandates WHERE id = ? FOR UPDATE
5. mandate live · unrevoked · scope · category
6. BURN the nonce       INSERT INTO intent_nonces — the PK is the burn.
                        23505 ⇒ INT-002. rolls back with the txn.
7. CAP READ             SUM over reservations in ('held','captured') within the rolling window
8. caps                 per-transaction (LMT-001) · cumulative (LMT-002)
                        · spend velocity from reservations (LMT-003)
9. step-up triggers     STP-001/002/003
10. CONSUME the quote   UPDATE quotes SET consumed_at … WHERE consumed_at IS NULL
                        0 rows ⇒ INT-002.  on ALLOW and STEP_UP, never on DENY
11. INSERT reservation ('held') + ledger INTENT · DECISION · RESERVATION rows
12. COMMIT              lock releases here
13. executor service call   AFTER commit, never during
```

`READ COMMITTED` is correct and deliberate: the explicit row lock serialises every authoriser for
this mandate, and each statement after the lock sees committed data. `SERIALIZABLE` would add
predicate locking we do not use and produce `40001` storms under the fifty-way test. Retry only
`40P01`/`55P03`, 3 attempts, 10/40/160 ms with jitter; exhaustion returns `SYS-003`.

**Any transaction moving a reservation out of `('held','captured')` must take the mandate row
lock** — it changes the cap sum. `held → captured` does not.

**STEP_UP approval does not re-run this sequence.** The nonce is burned and the quote consumed on
the first pass. Approval runs a narrow locked transaction that re-checks the mandate and the
reservation, writes an ALLOW decision, and executes.

Deleting step 4, or moving step 7 out of the transaction, or counting only settled
payments in step 7, each silently breaks the headline claim with no error.

## Deployment

The kernel is a **standalone HTTP service**, packaged as one Docker image. Six services:

| Service | Public? | Holds `RZP_KEY_SECRET`? |
|---|---|---|
| `postgres` | no | — |
| `executor` | **no ingress at all** | **yes — the only one** |
| `kernel` (API · MCP · webhooks · **consent and step-up pages**) | yes | no |
| `worker` (pg-boss jobs) | no | no — holds the anchor signing key, no payment credential |
| `web` (storefront · audit console) | yes | no |
| `buyer-agent` | yes | no |

The executor is a separate service so the credential does not sit in the process that serves
public HTTP, and so `env | grep RZP` is empty in kernel, worker, web and buyer-agent. Kernel and
worker both call it over the internal network with `EXECUTOR_TOKEN`. See ADR-017.

**The kernel serves `/consent/*` and `/agent/approve/*`** — not `web`. ADR-008.

Three deployment shapes: in-process SDK (Node only), **Docker sidecar (the general case)**,
aggregator-hosted (spec only — do not build). The SDK is a thin HTTP wrapper over the same
service, so build the service first and both fall out.

## Payment modes

- `RAIL=replay` — a real HTTP service in the compose file serving responses recorded from live
  test mode, and firing real signed webhooks back. Every part of our system genuinely executes;
  only the far side of the socket is a recording. **Default. Zero credentials.**
- `RAIL=razorpay` — real Razorpay Test Mode.

Likewise `BRAIN=scripted|claude` for the buyer agent, and `VERIFIER=scripted|claude|off` for the
blind verifier — the scripted verifier is downgrade-only exactly like the real one, and `off` is
permitted only under `RAIL=replay` and writes a skip entry every time. The red-team suite needs
no model at all — the hostile agent is a script by design.

**The UI must always display the active mode.** Never let a viewer mistake replay for live.

## Stack

TypeScript everywhere, npm workspaces. Postgres 16 (SQL-first — we need `FOR UPDATE`, isolation
levels and `SET LOCAL`). Hand-written SQL migrations. Zod schemas as the single source of
truth. pg-boss for jobs (no Redis). Vitest + Testcontainers against real Postgres. Ed25519 via
`node:crypto`. JCS (RFC 8785) before every hash and signature. **BIGINT paise, never floats.**

## Development priority

Do these in order. Do not start a later item to avoid a blocked earlier one.

1. Razorpay rail spike + tunnel + **check whether Reserve Pay is enabled on the test account**
2. Replay rail
3. The two defining tests (compromised model, concurrency) — written **before** the kernel
4. Schema, migrations, roles, RLS
5. The locked transaction with reservation-based caps
6. Mandates, identity, quotes
7. Policy engine
8. Ledger + chain
9. Executor
10. Reconciliation + the jobs
11. Docker + compose + Makefile
12. Merchant console
13. Buyer agent
14. Seed data and demo scripts

**Gate:** if the concurrency test is not green, do not add surfaces.

## Do not

- Do not put authorisation logic in the LLM.
- Do not call an external model or API while holding the mandate lock.
- Do not count only settled payments toward caps.
- Do not give the buyer agent a payment credential, or a database role.
- Do not commit credentials — test-mode included.
- Do not use floats for money.
- Do not mock Postgres in tests. Testcontainers, real engine, real isolation levels.
- Do not build: a native app, the aggregator-hosted tier, multi-merchant marketplaces,
  fine-tuned models, or protocols beyond MCP and an ACP-shaped endpoint.
- Do not modify a security test to make an implementation pass.

## How to work with me

Before any architectural change, tell me:

1. Which invariant it affects
2. Why it is necessary
3. Which component owns the enforcement
4. Which test proves it
5. Whether it moves the trust boundary

Never make architectural changes silently. Never resolve a contradiction between documents on
your own — surface it.

Every invariant needs one enforcement point, one test that goes red when that enforcement is
deleted, and one place a reviewer can watch it work. Mark enforcement points with a grep-able
comment: `// INV-05: caps read reservations under the mandate row lock`.

## Judging context

Judges will clone this and run it themselves. `docker compose up` must work first try on a
stranger's machine with no accounts, on macOS, Windows and Linux, arm64 and amd64. Anything
flaky reads as broken. `docs/submission.md` has the full requirements.
