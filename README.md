# AgentKit for Razorpay

An agentic-commerce trust layer. It lets third-party AI agents transact with a merchant
while making it structurally impossible for the AI to move money on its own.

The trust boundary sits *below* the model, not around it. A fully compromised agent gets
one transaction, at an allowlisted merchant, under the silent threshold, fully logged and
reversible — not because the model was defended, but because it was never trusted.

## Start here

```bash
make up      # everything, seeded, no accounts and no keys
make demo    # six scenarios, end to end
```

Then [`JUDGES.md`](JUDGES.md) — a numbered path, about fifteen minutes.

| | |
|---|---|
| `make prove` | deletes each control, shows the suite catching it |
| `make attack` | the red-team suite |
| `make verify` | recomputes every hash chain from raw rows |
| `make invariants` | the enforcement table with `file:line` |
| `make judge` | all of the above |

## The bounds are layered, and only the inner ones are ours

Two of these are enforced by NPCI and Razorpay, independently of anything we run. Three
are ours, and every one of ours is narrower.

| Bound | Set by | Value |
|---|---|---|
| Rail ceiling | NPCI / Razorpay | ₹1,00,000 per mandate |
| Rail PIN threshold | NPCI / Razorpay | ₹15,000 |
| **Policy silent threshold** | our mandate | **₹500** |
| Policy per-transaction cap | our mandate | ₹5,000 |
| Policy cumulative | our mandate | ₹15,000 per 30 days |

Razorpay's own wording: *"UPI — Accept payments upto ₹1,00,000. Payments above ₹15,000
will ask the customer for UPI PIN verification as well."* The outer bounds are visible on
the merchant's settings page, so the layering is checkable rather than asserted.

**Every demo amount stays below ₹15,000.** Above it the rail forces a PIN, and a viewer
would see the prompt and conclude our silent path does not work — when what they were
watching was NPCI's threshold, not ours.

## The bug that argues for the method

In PostgreSQL, `ORDER BY` binds to an output column name in preference to the underlying
column — unlike `WHERE`, which does not — so aliasing a cast to the same name silently
turns a numeric sort into a lexicographic one. Our ledger head query did exactly that, and
every hash chain built correctly until it reached ten entries, at which point `'9'` sorted
above `'10'` and every subsequent append computed a stale predecessor. Every isolated
probe passed; only the fifty-concurrent-intent test — written before the kernel existed —
found it.

Full writeup in [`evidence/order-by-alias-capture.md`](evidence/order-by-alias-capture.md).

## Invariants

Twenty-three. Each has one enforcement point, one test that goes red when that enforcement
is deleted, and one place you can watch it hold. Regenerate this table with
`make invariants` — it is derived from the markers in the tree, not maintained by hand.

`PROVEN` means a test goes red when the enforcement is removed. `ENFORCED` means the code
exists but nothing yet proves it is reached on every path. We ship them labelled as they
actually are.

| ID | Invariant | Enforcement | Grade |
|---|---|---|---|
| `INV-01` | No model output is ever executed | `src/modules/authorization/authorization.service.ts:25` | PROVEN |
| `INV-02` | No payment credential exists in any process other than the executor service | `src/modules/executor/executor.service.ts:20` | PROVEN |
| `INV-03` | No debit without a valid, unexpired, unrevoked mandate binding user → agent → scope | `src/modules/policy/policy.service.ts:116` | PROVEN |
| `INV-04` | Every money-moving call carries `sha256(intent_id)` as its idempotency key | `src/modules/rail/rail.http.ts:80` | PROVEN |
| `INV-05` | Caps are evaluated over reserved + captured amounts read from the database, never from th… | `src/modules/authorization/authorization.repository.ts:110` | PROVEN |
| `INV-06` | Executed amount equals the signed quote amount exactly | `src/modules/authorization/authorization.stateless.ts:55` | PROVEN |
| `INV-07` | An ambiguous outcome is never retried blindly | `src/modules/reconciler/reconciler.service.ts:22` | PROVEN |
| `INV-08` | Any kernel dependency unavailable means DENY `SYS-001` | `src/modules/policy/policy.service.ts:10` | PROVEN |
| `INV-09` | Revocation takes the same mandate row lock authorisation takes | `src/modules/mandate/mandate.service.ts:95` | ENFORCED |
| `INV-10` | Every decision — especially every denial — writes exactly one ledger entry with one reaso… | `src/modules/authorization/authorization.service.ts:436` | PROVEN |
| `INV-11` | The ledger is append-only and hash-chained per mandate, with periodic anchors | `src/modules/ledger/ledger.service.ts:56` | PROVEN |
| `INV-12` | Untrusted content is never instruction and never reaches a decision-bearing field | `src/shared/taint.ts:2` | PROVEN |
| `INV-13` | Every mandate binds a fresh authentication event | `src/modules/consent/consent.service.ts:235` | ENFORCED |
| `INV-14` | Every signed quote names the mandate it was issued to; execution requires subject equality | `src/modules/quote/quote.service.ts:56` | PROVEN |
| `INV-15` | A provider event is applied at most once — uniqueness on `provider_event_id` inside the t… | `src/modules/reconciler/reconciler.repository.ts:14` | PROVEN |
| `INV-16` | Every signature carries a `kid` | `src/modules/identity/identity.service.ts:63` | ENFORCED |
| `INV-17` | The blind verifier may only downgrade ALLOW → DENY, and runs outside any transaction | `src/modules/verifier/verifier.service.ts:9` | PROVEN |
| `INV-18` | The ledger holds pseudonymous identifiers only; erasure deletes the mapping and leaves th… | `migrations/005_grants.sql:92` | ENFORCED |
| `INV-19` | No external network call occurs while the mandate row lock is held | `src/modules/rail/rail.http.ts:65` | PROVEN |
| `INV-20` | Every reservation is eventually resolved — captured, released by the reconciler, or reape… | `src/modules/jobs/release-stale.job.ts:8` | ENFORCED |
| `INV-21` | Merchant isolation is enforced by PostgreSQL RLS with `FORCE` on six tables, not by appli… | `migrations/004_rls.sql:1` | PROVEN |
| `INV-22` | Replay mode runs end to end with zero external credentials | `docker-compose.yml:1` | PROVEN |
| `INV-23` | The active rail, brain and verifier modes are shown in the UI and returned by `/health` | `src/services/web/main.ts:25` | PROVEN |

`make prove` removes seven of these controls one at a time and shows the suite catching
each. Seven removed, seven tests red.

## What we cannot claim

Naming the limits first is how payments people establish credibility.

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

`STP-003` (anomalous basket relative to history) is reserved in the enum, never emitted,
and not implemented. A history model faked in a weekend would be the actual mistake.

## Status

Complete: schema and roles, the locked transaction, identity and the chain, the executor,
the replay rail, reconciliation and the jobs, Docker and compose, the consoles, consent
and step-up, the buyer agent, and the red-team suite.

**139 tests** against real PostgreSQL via Testcontainers. Ten consecutive green runs, and
CI runs the concurrency test ten times on every push because nine out of ten is broken.

Evidence is committed in [`evidence/`](evidence/): the `make prove` output, ten
concurrency runs, chain verification including a tamper that gets caught, and the
credential-isolation check.
