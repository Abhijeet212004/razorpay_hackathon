# Security Invariants

Twenty-three invariants. Each needs **one enforcement point**, **one test that fails if you delete
that enforcement**, and **one observable surface** where a reviewer can watch it hold.

Grades are honest targets, not aspirations:

- `PROVEN` — enforced in code, and a test goes red when the enforcement is removed
- `ENFORCED` — code exists, nothing yet proves it is reached on every path
- `ASSERTED` — true of the design, nothing in the repo holds it true

Ship them labelled as they actually are. An `ENFORCED` row costs nothing. A `PROVEN` row that
isn't costs everything.

---

| ID | Invariant | Enforcement | Target |
|---|---|---|---|
| INV-01 | No model output is ever executed. Models produce intents; the kernel produces actions. | architecture | PROVEN |
| INV-02 | **No payment credential exists in any process other than the executor service.** Boot-time assertion in every other entrypoint, plus a compose/CI check. | `kernel/assert-no-credential.ts` | PROVEN |
| INV-03 | No debit without a valid, unexpired, unrevoked mandate binding user → agent → scope. | `policy/rules/mandate.ts` | PROVEN |
| INV-04 | Every money-moving call carries `sha256(intent_id)` as its idempotency key. | `executor/execute.ts` | PROVEN |
| INV-05 | **Caps are evaluated over reserved + captured amounts read from the database, never from the request, inside a READ COMMITTED transaction holding the mandate row lock.** | `kernel/authorize.ts` | PROVEN |
| INV-06 | Executed amount equals the signed quote amount exactly. Zero tolerance. | `policy/rules/quote.ts` | PROVEN |
| INV-07 | An ambiguous outcome is never retried blindly. It is reconciled by reading provider state. | `reconciler/` | PROVEN |
| INV-08 | Any kernel dependency unavailable means DENY `SYS-001`. Fail closed. | `policy/evaluate.ts` | PROVEN |
| INV-09 | Revocation takes the same mandate row lock authorisation takes. A payment already in flight is reconciled and refunded as a compensating entry. | `mandate/revoke.ts` | ENFORCED |
| INV-10 | Every decision — especially every denial — writes exactly one ledger entry with one reason code. | the gate, not the handler | PROVEN |
| INV-11 | The ledger is append-only and hash-chained per mandate, with periodic anchors. Corrections are compensating entries. | `001_ledger.sql` + `ledger/append.ts` | PROVEN |
| INV-12 | Untrusted content is never instruction and never reaches a decision-bearing field. | branded types, compile time | PROVEN |
| INV-13 | Every mandate binds a fresh authentication event. Ambient session state is never consent. | `identity/grant.ts` | ENFORCED |
| INV-14 | Every signed quote names the mandate it was issued to; execution requires subject equality. | `policy/rules/quote.ts` | PROVEN |
| INV-15 | A provider event is applied at most once — uniqueness on `provider_event_id` inside the transition transaction. | `reconciler/ingest.ts` | PROVEN |
| INV-16 | Every signature carries a `kid`. Verification accepts retired keys; issuance uses only the active one. | `crypto/sign.ts` | ENFORCED |
| INV-17 | **The blind verifier may only downgrade ALLOW → DENY, and runs outside any transaction.** Its unavailability never grants. | `policy/verifier.ts` | PROVEN |
| INV-18 | The ledger holds pseudonymous identifiers only; erasure deletes the mapping and leaves the chain verifiable. | `ledger/redact.ts` | ENFORCED |
| INV-19 | **No external network call occurs while the mandate row lock is held.** Enforced process-wide: the HTTP client throws when an AsyncLocalStorage `lockHeld` flag is set by `authorize.ts`. | `kernel/egress-guard.ts` | PROVEN |
| INV-20 | **Every reservation is eventually resolved** — captured, released by the reconciler, or reaped when no execution was ever attempted. Never reaped while its order is unresolved. | `worker/release-stale.ts` | ENFORCED |
| INV-21 | Merchant isolation is enforced by PostgreSQL RLS with `FORCE` on six tables, not by application code. | `004_rls.sql` | PROVEN |
| INV-22 | Replay mode runs end to end with zero external credentials. | CI job with no secrets | PROVEN |
| INV-23 | The active rail, brain and verifier modes are shown in the UI and returned by `/health`. | `web/ModeBadge.tsx` + `kernel/health.ts` | PROVEN |

---

## INV-05 in detail — reservation-based caps

This is the invariant most likely to be implemented wrongly, and the failure is silent.

### The bug being prevented

Counting only settled payments looks correct and is not:

```
Intent A: lock → settled spend ₹14,000 → +₹900 passes → commit → release
Intent B: lock → settled spend STILL ₹14,000 (A's webhook hasn't arrived)
                → +₹900 passes → commit
Result:   ₹15,800 authorised against a ₹15,000 cap. No error. No crash.
```

The row lock prevents *simultaneous* reads. It does not prevent *sequential* reads of stale
settled-only state. The window is however long settlement takes — seconds to minutes — which
is ample.

### The model

```sql
CREATE TABLE reservations (
  reservation_id TEXT PRIMARY KEY,
  mandate_id     TEXT NOT NULL,
  merchant_id    TEXT NOT NULL,       -- denormalised: the RLS predicate column
  intent_id      TEXT NOT NULL UNIQUE,
  amount_paise   BIGINT NOT NULL,
  state          TEXT NOT NULL,       -- 'held' | 'captured' | 'released'
  step_up        BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at    TIMESTAMPTZ
);

CREATE INDEX reservations_cap_idx ON reservations (mandate_id, created_at)
  WHERE state IN ('held', 'captured');

ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservations FORCE  ROW LEVEL SECURITY;
CREATE POLICY reservations_tenant ON reservations
  USING (merchant_id = current_setting('agentkit.merchant_id', true));
```

The cap query, inside the locked transaction:

```sql
SELECT COALESCE(SUM(amount_paise), 0)
FROM reservations
WHERE mandate_id = $1
  AND state IN ('held', 'captured')
  AND created_at > now() - $2::interval;
```

### State transitions

| From | To | Trigger |
|---|---|---|
| — | `held` | ALLOW, inside the locked transaction |
| — | `held` | STEP_UP, `step_up = true`, TTL tied to the challenge (ADR-020) |
| `held` | `captured` | webhook `payment.captured`, confirmed by `orders.fetch` |
| `held` | `released` | payment failed, or the intent never reached the executor |
| `held` | `released` | reaped after TTL by `release-stale-reservations` |
| `captured` | `released` | refunded (compensating entry) |

**`AMBIGUOUS` keeps the reservation `held`** — conservative, and correct: we do not know whether
the money moved, so the cap must assume it did.

**The reaper is not optional**, and its rule is narrow: reap only when the reservation is `held`,
**no order row exists for its intent**, and it is older than `RESERVATION_TTL` (15 min). Never
reap while an order is `SUBMITTED` or `AMBIGUOUS` — those belong to the reconciler, which gives
up at `RECONCILE_MAX_AGE` (24 h), marks the order `FAILED_UNRESOLVED`, releases the reservation
and alerts. Reaper runs every 60 s. See rulings-001 Q-4/Q-5.

Releasing takes the mandate row lock, because it changes the cap sum. `held → captured` does not.

### The test that proves it

```
50 concurrent intents · ₹900 each · ₹900 of headroom · no webhooks delivered
⇒ exactly 1 ALLOW, 49 DENY LMT-002
⇒ SUM(reservations where state='held') == 900_00
```

The "no webhooks delivered" clause is what makes this test catch the settled-only bug. Delete
the reservation write and it goes red. Delete the row lock and it goes red. Both must be true.

---

## INV-17 / INV-19 in detail — the verifier outside the lock

A 1500 ms inference call inside a `FOR UPDATE` serialises every purchase on that mandate behind
an API we do not control. Worse, combined with fail-closed it converts an inference outage into
a commerce outage.

**Rule:** the verifier runs after stateless validation and before `BEGIN`, and its result is
memoised for the request so a lock retry does not re-run it.

Safe because it can only subtract permission — running it early means a "no" denies regardless
of what the caps would have said, and a "yes" still faces every check.

```
timeout, amount >  silent_threshold  → DENY SYS-002
timeout, amount <= silent_threshold  → proceed, write a ledger entry recording the skip
```

Model it as a distinct stage, never as a policy rule — modelling it as a rule makes it possible
for a later edit to place it somewhere it could grant.

---

## Reason codes

| Code | Verdict | Condition |
|---|---|---|
| `OK-000` | ALLOW | All rules passed |
| `AUT-001` | DENY | No authentication event bound to this mandate |
| `AUT-002` | DENY | Bound auth event older than the freshness bound |
| `MND-001` | DENY | No mandate binds this user, agent and scope |
| `MND-002` | DENY | Mandate expired |
| `MND-003` | DENY | Mandate revoked, including mid-flight |
| `LMT-001` | DENY | Per-transaction cap exceeded |
| `LMT-002` | DENY | Cumulative window cap exhausted (reserved + captured) |
| `LMT-003` | DENY | Velocity limit exceeded |
| `LMT-004` | DENY | Offer breaches margin floor or promo budget |
| `LMT-005` | DENY | Rate limit or global spend-velocity breaker |
| `SCP-001` | DENY | Merchant not on the mandate allowlist |
| `SCP-002` | DENY | Category outside granted scope |
| `INT-001` | DENY | Intent signature invalid or agent key unknown |
| `INT-002` | DENY | Intent expired, or nonce already spent |
| `INT-003` | DENY | Amount does not match the signed quote |
| `INT-004` | DENY | Quote was issued to a different mandate |
| `SEC-001` | DENY | Tainted content reached a decision-bearing field |
| `SEC-002` | DENY | Agent not registered / attestation failed |
| `SEC-003` | DENY | Hash chain verification failed — halts the mandate |
| `SEC-004` | DENY | Blind verifier objected. Explanation to the agent stays generic — its reasoning is never surfaced |
| `SYS-001` | DENY | Kernel dependency unavailable. Fail closed |
| `SYS-002` | DENY | Blind verifier timed out above the silent threshold |
| `SYS-003` | DENY | Authorisation could not be serialised — lock retry budget exhausted |
| `STP-001` | STEP_UP | Amount above the silent threshold |
| `STP-002` | STEP_UP | First transaction with this merchant under this mandate |
| `STP-003` | STEP_UP | Anomalous basket relative to history — **reserved, never emitted, not implemented** |

---

## Residual risks — write these in the README

Naming limits first is how payments people establish credibility.

| | |
|---|---|
| R1 | Executor key compromise is unbounded. Minimised to one process, allowlisted egress, no model near it. That is the entire mitigation. |
| R2 | Key custody is not production-grade. No HSM, no rehearsed rotation, no key ceremony. |
| R3 | The revocation window is covered, not eliminated. In-flight payments complete, then refund. |
| R4 | SMS OTP is a weak factor — SIM swap, interception. It makes the binding real; it is not strong authentication. |
| R5 | The blind verifier is heuristic, with an unmeasured false-positive rate. Defence in depth only. |
| R6 | No third-party review. The red-team suite tests attacks we thought of. |
| R7 | No operational assurance — no SOC 2, no on-call, no runbooks, no DPDP registration. |
| R8 | Serialising a mandate on one row means an attacker who can submit intents can make that mandate slow for its owner. A deliberate trade of availability for correctness. |
| R9 | No account recovery. Lose the phone or suffer a SIM swap and the user cannot grant, widen or step up, and revoking needs an auth path we do not specify. |
