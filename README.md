# AgentKit for Razorpay

An agentic-commerce trust layer. It lets third-party AI agents transact with a merchant
while making it structurally impossible for the AI to move money on its own.

The trust boundary sits *below* the model, not around it. A fully compromised agent gets
one transaction, at an allowlisted merchant, under the silent threshold, fully logged and
reversible — not because the model was defended, but because it was never trusted.

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

## Status

Phases 1–4 complete: schema and roles, the locked transaction, identity and the chain,
the executor, the replay rail, reconciliation and the jobs. 112 tests against real
PostgreSQL via Testcontainers, ten consecutive green runs.

Still to come: Docker and compose (Phase 5), the consoles, buyer agent and red-team suite
(Phase 6).

Run `make invariants` for the current enforcement table with `file:line`.
