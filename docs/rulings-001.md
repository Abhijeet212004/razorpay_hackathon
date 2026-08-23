# Rulings 001 — resolving the pre-implementation review

Answers to every question and contradiction raised before Phase 1. **This document supersedes
anything it contradicts, including CLAUDE.md**, and its content has been folded back into
`CLAUDE.md`, `decisions.md` (ADR-016…023) and `security-invariants.md`.

Where a ruling changes an earlier decision, the reason is given. Where the review was simply
right, it says so.

---

## Namespace and layout

**C-9 — INV numbering.** `INV-NN` means the table in `security-invariants.md`, always. CLAUDE.md's
non-negotiables no longer carry their own numbers; they now cite INV IDs. Use `// INV-05: …` for
grep-able enforcement comments.

**Q-23 — repo layout.** Move to root: `CLAUDE.md`, `docs/`, and later `README.md`, `JUDGES.md`,
`evidence/`. Delete `ctx/`. Yes, add the remote. That is the first commit.

---

## The transaction

**Q-1 — where it lives.** Accepted as proposed. `kernel/authorize.ts` owns
`BEGIN → FOR UPDATE → cap read → reservation write → COMMIT`. `policy/evaluate.ts` becomes a
**pure fold over already-read values** and owns no I/O. Enforcement moves:

| | was | now |
|---|---|---|
| INV-05 | `policy/evaluate.ts` | `kernel/authorize.ts` |
| INV-08 | `policy/evaluate.ts` | `policy/evaluate.ts` (the fold's default arm) — unchanged |
| INV-19 | `policy/evaluate.ts` | `kernel/egress-guard.ts` |

**Q-2 — isolation level and retries. This is a real defect and the fix changes the design.**

We do not need `SERIALIZABLE`. We take an explicit row lock on the mandate, and every read that
matters happens *after* the lock is held. Under `READ COMMITTED`, each statement sees a fresh
snapshot of committed data, so a competing authoriser has either committed (and is visible in
the cap read) or has not yet acquired the lock. That is exactly the guarantee we need.

`SERIALIZABLE` adds predicate locking we do not use and generates `40001` serialization failures
under the fifty-way concurrency test — which is why the test's asserted shape looked unreachable.
It was.

**Ruling: `READ COMMITTED` plus `SELECT … FOR UPDATE`.** See ADR-016.

- `lock_timeout = 3s`, `statement_timeout = 5s` on the authorisation transaction.
- Retry only on `40P01` (deadlock) and `55P03` (lock not available): **3 attempts**, backoff
  10 ms / 40 ms / 160 ms with ±50% jitter.
- The blind verifier is **not** re-run on retry — its result is memoised per request. Correct
  reasoning in the review.
- The nonce burn rolls back with the transaction and is re-attempted. That is intended.
- Exhausting the budget returns **`SYS-003` — authorisation could not be serialised** (new code).
  Not `SYS-001`: a dependency being unavailable and a lock being contended are different
  operational signals and must be distinguishable in the metrics.

**One constraint this creates, and it is load-bearing:** any transaction that moves a reservation
*out of* `('held','captured')` must take the mandate row lock, because it changes the cap sum.
That is `release` and `reap`. A `held → captured` transition does **not** need the lock, because
both states are counted and the sum is unchanged. Write this down in the reconciler.

---

## Schema gaps

**Q-3 — the nonce store.** A separate table. The intent nonce is agent-issued; the quote's nonce
is server-issued. Different issuers, different lifecycles, different tables.

```sql
CREATE TABLE intent_nonces (
  nonce      TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL,
  intent_id  TEXT NOT NULL,
  burned_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**The primary key is the burn.** Burning is an `INSERT`; a replay raises `23505` → `INT-002`.
No read-then-write, no race. Prune rows older than the maximum intent TTL in the worker.

**Q-7 — quote consumption.** Inside the lock, in the same statement group as the reservation
write:

```sql
UPDATE quotes SET consumed_at = now(), consumed_by = $intent_id
WHERE quote_id = $1 AND consumed_at IS NULL;
-- 0 rows affected ⇒ INT-002 (quote already consumed)
```

Add `consumed_at`, `consumed_by` to `quotes`. The quote is consumed on **ALLOW and STEP_UP**, not
on DENY.

**Q-13 — RLS mechanics.**

- `FORCE ROW LEVEL SECURITY` on: `ledger`, `mandates`, `reservations`, `quotes`, `orders`,
  `webhook_events`.
- **`reservations` gains a `merchant_id` column**, denormalised from the mandate. The review is
  right that it cannot be scoped without one.
- Session variable: `SET LOCAL agentkit.merchant_id = '…'`.
- Policy: `USING (merchant_id = current_setting('agentkit.merchant_id', true))`. The `true`
  argument means a missing setting yields `NULL`, which matches no rows — fail closed, which is
  the correct direction.
- Set by request middleware in the kernel and the console; in the worker, set per job from the
  job payload. `verify-chain` iterates merchants and sets the context per merchant.
- `agents` and `auth_events` carry no merchant data and stay outside RLS.

---

## Reservations

**Q-6 — STEP_UP writes a reservation.** Yes, `held`, with TTL tied to the challenge expiry.
Otherwise an attacker issues a hundred step-ups reserving nothing and approves them in a burst.
Released when the challenge expires or is rejected.

**C-7 — step-up re-entry. The review found a real bug; the fix is to stop re-entering.**

"Re-enter the authorisation transaction from the top" is wrong — the nonce was burned and the
quote consumed on the first pass. **Approval does not re-run the sequence.** It runs a narrow
transaction:

```
BEGIN READ COMMITTED
SELECT … FROM mandates WHERE id = ? FOR UPDATE
  challenge valid, unexpired, unconsumed, bound to this intent_id
  mandate still live and unrevoked
  reservation still 'held'
  quote not expired
INSERT ledger DECISION (ALLOW, STP-001 satisfied)
mark challenge consumed
COMMIT  →  executor
```

No nonce re-burn, no re-quote, no second verifier call. **Consequence: quote TTL must outlive the
challenge.** Set quote TTL 10 minutes, challenge TTL 5 minutes.

**Q-4 — reaper vs AMBIGUOUS.** The review is right that these collide. The rule:

> Reap a reservation only when it is `held`, **no order row exists for its intent**, and it is
> older than `RESERVATION_TTL`. Never reap while an order exists in `SUBMITTED` or `AMBIGUOUS` —
> those belong to the reconciler.

That covers the real case the reaper exists for: a crash between `COMMIT` and the executor call,
where money definitely never moved.

Unresolved orders need a terminal deadline of their own, or they hold cap forever. After
`RECONCILE_MAX_AGE` the reconciler gives up, marks the order `FAILED_UNRESOLVED`, releases the
reservation, and raises an operator alert.

INV-20's wording becomes: *every reservation is eventually resolved — captured, released by the
reconciler, or reaped when no execution was ever attempted. A reservation is never reaped while
its order is unresolved.*

**Q-5 — the numbers.**

| | |
|---|---|
| `RESERVATION_TTL` (no order exists) | 15 min |
| Reaper schedule | every 60 s |
| Reconciler backoff | 5 s · 15 s · 45 s · 2 m · 5 m · 15 m · 30 m, then hourly |
| `RECONCILE_MAX_AGE` | 24 h → `FAILED_UNRESOLVED` + alert |
| Challenge TTL | 5 min |
| Quote TTL | 10 min |
| `lock_timeout` | 3 s |

**Q-17 — reservation state → ledger kind.** Every state change writes an entry.

| transition | kind |
|---|---|
| — → `held` (ALLOW) | `RESERVATION` |
| — → `held` (STEP_UP) | `RESERVATION`, `step_up: true` in payload |
| `held` → `captured` | `EXECUTION_RESULT` |
| `held` → `released` (payment failed) | `RELEASE` |
| `held` → `released` (reaped) | `RELEASE`, `reason: reaped` |
| `held` → `released` (challenge expired/rejected) | `RELEASE`, `reason: step_up_abandoned` |
| `held` → `released` (unresolved at 24 h) | `RELEASE`, `reason: unresolved` |
| `captured` → `released` (refund) | `REFUND` |

**Q-11 — velocity source.** Reservations, states `('held','captured')`, created in the last hour.
Counting settled ledger rows would carry the exact stale-read bug ADR-003 exists to kill.

**Q-10 / C-8 — rolling, not calendar.** The SQL is right and the UX copy is wrong. A calendar
month lets someone spend 2× the cap across a boundary. Change fig3's copy to
*"₹180 available now · ₹740 frees up on 20 Sept"*, computed from the oldest counted reservation.

---

## Processes and credentials

**C-3 — the worker needs a credential it is forbidden to hold. The review is right, and the fix
is a sixth service.**

Neither option in the review is good enough. Giving the worker the key breaks INV-02; routing it
through the kernel means the credential sits in the process that also serves public HTTP.

**Ruling: the executor becomes its own service.** Same image, `CMD` runs
`dist/executor/serve.js`, **no public ingress** — internal network only. Kernel and worker both
call it. See ADR-017.

- Auth: `EXECUTOR_TOKEN`, a long random shared secret, plus no public route.
- `RZP_KEY_SECRET` now exists in exactly one service, and `env | grep RZP` is empty in
  **kernel, worker, web and buyer-agent** — a materially stronger demonstrable claim than before.
- Cost: about an hour. Worth it.

**C-10 — INV-02 widened.** *No payment credential exists in any process other than the executor
service.* The compromised-model test asserts this for every other service.

**C-5 — who serves the consent pages.** The kernel. `/consent/*` and `/agent/approve/*` are
kernel routes. `web` serves the storefront and the console only. CLAUDE.md's deployment table was
wrong and is fixed.

**C-4 + Q-9 — the role matrix.** `agentkit_consent` **is deleted.** It only existed because a
separate Next.js app was assumed to grant mandates; ADR-008 killed that assumption and the role
did not follow. Consent runs inside the kernel under `agentkit_kernel`, which resolves C-4
entirely. Three roles, differently drawn:

| role | used by | grants |
|---|---|---|
| `agentkit_kernel` | kernel, executor | SELECT, INSERT on `ledger`, `reservations`, `quotes`, `orders`, `intent_nonces`, `auth_events`, `webhook_events`, `mandates`, `agents`; UPDATE on `mandates` (revocation, chain head), `reservations` (state), `quotes` (consumed_at), `orders` (state); SELECT on `signing_keys` |
| `agentkit_worker` | worker | SELECT on `mandates`, `orders`, `reservations`, `quotes`; INSERT on `ledger`, `ledger_anchor`; UPDATE on `reservations` (state), `orders` (state), `mandates` (expiry); ALL on schema `pgboss` |
| `agentkit_console` | web console, `agentkit verify` | SELECT only, RLS-scoped |
| `agentkit_admin` | the `agentkit erase` CLI only — **no service** | DELETE on `pseudonym_map` |

`REVOKE UPDATE, DELETE ON ledger, ledger_anchor FROM` all four.

**Q-21 — erasure.** `agentkit erase --subject psu_…`, connecting as `agentkit_admin`. No running
service holds that role.

---

## Verifier, modes, and remaining items

**Q-14 — the verifier in replay mode.** The review is right that this breaks every step-up demo.
Third switch: `VERIFIER=scripted | claude | off`. Default in replay is `scripted` — a
deterministic function checking an implausibility fixture list, and **downgrade-only like the
real one**. `off` is permitted only when `RAIL=replay`, and writes a skip entry every time.

**Q-18 — rate limiting appears twice because they are two different checks.** Rename and split:

- **`LMT-005`, request rate** — edge only, Postgres-backed token bucket so it survives multiple
  instances. Not inside the lock.
- **`LMT-003`, spend velocity** — inside the lock, computed from reservations.

Step 5's "rate" is renamed "velocity". The edge check does not appear inside the transaction.

**Q-8 — two freshness bounds. The review is right that one bound kills every mandate.** Two rules,
and only one is a runtime check:

- **At grant / widen / step-up:** the auth event must be at most `PT5M` old → `AUT-002`.
- **At authorisation:** no age check at all. `AUT-001` fires only if the mandate carries no auth
  event reference. The mandate's own `not_after` (P30D) is the bound, and re-checking auth age
  would duplicate it wrongly.

`AUT-002` is therefore a grant-time, widen-time and step-up-time code only.

**Q-15 — thresholds confirmed.** Silent threshold ₹500 = `50000` paise. Per-transaction ₹5,000 =
`500000`. Cumulative ₹15,000 = `1500000` over `P30D`, rolling.

**Q-16 — fork violation.** Under the mandate lock a `23505` on `ledger_no_fork` should be
impossible; if it occurs it is a bug or an attack. **Roll back, do not retry, DENY `SEC-003`,
alert.** Retrying would mask exactly the condition the index exists to surface.

**Q-19 — `agentkit verify`.** Confirmed: a CLI connecting as `agentkit_console`, recomputing every
hash from raw rows. Add it to `architecture.md` as a component.

**Q-20 — anchors.** Every 5 minutes or every 100 ledger appends, whichever first. **Signed**, with
a dedicated `anchor` purpose key — `kid` and `sig` columns on `ledger_anchor`. Cheap, and it makes
the anchor independently attributable.

**Q-12 — three new invariants**, so the unnumbered non-negotiables get tests:

- **INV-21** — merchant isolation is enforced by RLS with `FORCE`. Test: set context A, assert B's
  rows are invisible; drop the policy and the test goes red.
- **INV-22** — replay mode runs with zero external credentials. Test: a CI job with no secrets
  configured runs `make up && make demo`.
- **INV-23** — the active rail, brain and verifier modes are displayed in the UI and returned by
  `/health`. Test: snapshot.

**Q-22 — Reserve Pay.** Still open, still mine to answer, still item #1. I will confirm before
Phase 4. It does not block Phase 1.

---

## The plates are stale and must not ship

**C-1, C-2, C-6 confirmed.** `fig2` draws the settled-only cap query that ADR-003 rules out, and
puts the verifier inside the lock. `fig1` has no `reservations` table and no reaper job. A judge
reading them sees the vulnerability the project claims to prevent, drawn as the design.

They are documentation, not code, and do not block Phase 1 — but they must be redrawn before
submission. Tracked as the next documentation task.

---

## Phase 1 is unblocked

Every blocker named in the review is ruled on: Q-3 nonce table, Q-9/C-4 role matrix, Q-13 RLS
mechanics and `reservations.merchant_id`, Q-2 isolation level and retries, C-9 namespace,
Q-23 layout.

Proceed with Phase 1: migrations, three service roles plus the admin role, `FORCE` RLS on six
tables, revoked `UPDATE`/`DELETE` on the ledger, the anti-fork index, `reservations`,
`intent_nonces`, and the two failing tests.

The concurrency test's asserted shape now holds without a retry storm: **50 intents, ₹900 of
headroom, no webhooks delivered ⇒ exactly 1 ALLOW, 49 DENY `LMT-002`, and
`SUM(amount) WHERE state = 'held'` = 90000 paise.**
