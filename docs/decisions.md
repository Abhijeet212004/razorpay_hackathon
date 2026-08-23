# Architecture Decisions

One record per decision that would be expensive to reverse, or that a reader might otherwise
undo by accident. Format: decision, reason, and what it rules out.

---

## ADR-001 — The kernel is a standalone HTTP service

**Decision.** The trust kernel is a service, not a library. It ships as one Docker image.

**Reason.** It makes the Docker sidecar the general deployment case, and reduces the SDK to a
thin HTTP wrapper. Building a library first and extracting a service later is a refactor we do
not have time for.

**Rules out.** Any design where enforcement lives in the merchant's process.

---

## ADR-002 — The model may deny, never allow

**Decision.** No language model sits on the path from intent to authorisation. Models can
subtract permission; they can never grant it. Model unavailability never grants either.

**Reason.** Authorisation must be deterministic, testable and reviewable. A prompt is not
enforcement.

**Rules out.** LLM-as-judge on the decision path; "the model checks the limits"; any design
where an inference failure defaults to allow.

---

## ADR-003 — Reservation-based spending caps

**Decision.** Authorised-but-unsettled amounts count against the cap. A reservation row is
written inside the locked transaction at ALLOW, and resolved to `captured` or `released` later.

**Reason.** Settled-only accounting is a concurrency vulnerability. Two sequential intents can
each read a settled total that excludes the other, and both pass, because settlement lags
authorisation by seconds to minutes. The row lock does not save you — it prevents simultaneous
reads, not sequential reads of stale state.

**Rules out.** `SUM(amount) WHERE kind = 'EXECUTION_RESULT'` as the cap query. **This was the
original design and it was wrong.**

**Requires.** A reaper job. Without it an abandoned hold consumes cap until the window rolls.

---

## ADR-004 — The blind verifier runs outside the transaction

**Decision.** The verifier is called after stateless validation and before
`BEGIN` / `SELECT … FOR UPDATE`.

**Reason.** Never hold a database lock across an external model or API call. A 1500 ms
inference call inside the lock serialises every purchase on that mandate behind a third party.
Safe outside the lock because the verifier can only downgrade.

**Rules out.** Modelling the verifier as a policy rule inside the evaluator fold — that makes it
possible for a later edit to place it somewhere it could grant.

---

## ADR-005 — One hash chain per mandate, not one global chain

**Decision.** `chain_id = mandate_id`, with a periodic `ANCHOR` entry checkpointing every live
chain head, and `UNIQUE (chain_id, prev_hash)` making a fork unwritable.

**Reason.** A global chain forks when two concurrent appends read the same tail, and
pre-commit sequence numbers make a verifier report breaks that never happened — the
tamper-evidence claim would fail during evaluation for reasons unrelated to tampering.
Per-mandate chains inherit the row lock the cap check already holds, so serialisation is free.

---

## ADR-006 — Quotes bind their subject mandate

**Decision.** The signed quote carries `mandate_id`; the policy engine asserts
`quote.mandate_id == intent.mandate_id` (`INT-004`).

**Reason.** An unbound signed quote is a transferable credential for a price — obtainable under
a permissive mandate and spendable under a restrictive one.

---

## ADR-007 — Two rail modes, both honest

**Decision.** `RAIL=replay` runs a real HTTP service serving responses recorded from live test
mode and firing real signed webhooks back. `RAIL=razorpay` uses real Razorpay Test Mode. The UI
always displays which is active.

**Reason.** Judges will clone and run this without a Razorpay account. Replaying at the socket
boundary means our executor, reconciler, signature verification, event dedupe and `orders.fetch`
all genuinely execute — unlike in-process mocking, where none of that code runs.

**Rules out.** Shipping credentials of any kind. Presenting replayed traffic as live.

---

## ADR-008 — The consent and step-up screens are served by the kernel

**Decision.** Two server-rendered pages inside the guard layer, not a separate framework app.

**Reason.** Most merchants have no Next.js application, and some have no backend at all. The
screens are two pages, not an app. What actually matters is that they are rendered from
server-held state by an operator the agent cannot influence and the user can recognise.

**Note.** In the aggregator-hosted shape that operator is Razorpay, and one recognisable domain
across all merchants is *more* phishing-resistant than thousands of unfamiliar ones — the same
reason UPI apps own the PIN screen.

---

## ADR-009 — The rail's own factor is the step-up factor

**Decision.** At step-up the user authenticates with the UPI PIN they must enter anyway. No
second SMS OTP. SMS OTP is used only at `grant` (before any rail mandate exists) and at `widen`.

**Reason.** A UPI PIN is possession plus knowledge, verified by NPCI. An SMS OTP is possession
only, and vulnerable to SIM swap. Sending a weaker second factor for a moment already covered
by a stronger one is pure friction.

---

## ADR-010 — UPI Reserve Pay is the primary instrument

**Decision.** The mandate grant enrols a rail-level Reserve Pay authority. The policy mandate
sits inside it and can only ever be narrower.

**Reason.** Without a rail authority, every purchase needs a per-transaction PIN — which means
the human authorised each one, and the caps are decorating a human decision rather than
bounding an autonomous one. Reserve Pay is what makes a silent purchase possible at all.

**Verify on day one** whether Reserve Pay is enabled on the test account. If not, the silent
path falls back to payment links and we say so rather than staging it.

---

## ADR-011 — Postgres, and SQL-first tooling  (isolation level amended by ADR-016)

**Decision.** PostgreSQL 16 with Drizzle. Hand-written SQL migrations. Testcontainers in tests.

**Reason.** We depend on `SELECT … FOR UPDATE`, `SET LOCAL`, partial unique
indexes and `FORCE ROW LEVEL SECURITY`. Prisma abstracts exactly those; Mongo has none of them.
A mocked database in tests would let both concurrent transactions pass — going green on the
precise bug the design exists to prevent.

---

## ADR-012 — No agent framework

**Decision.** A hand-written tool loop under 200 lines. No LangChain, no LlamaIndex.

**Reason.** The boundary between model and system is the product. Delegating that boundary to a
third-party abstraction with its own retry, memory and prompt-assembly behaviour contradicts the
thesis, and hides the part a reviewer most wants to read.

---

## ADR-013 — Least-privilege database roles  ⚠️ SUPERSEDED BY ADR-018

**Decision.** `agentkit_kernel` (SELECT, INSERT on ledger — the only writer of history),
`agentkit_consent` (mandates only, zero ledger privilege), `agentkit_console` (SELECT only,
RLS-scoped).

**Reason.** The earlier design said the console was read-only while also granting and revoking
mandates, which cannot both be true.

---

## ADR-014 — Build one surface deeply, three thinly

**Decision.** The agent-readable catalog surface is production-shaped. Conversational checkout,
upsell and campaign orchestrator are thin adapters over the same kernel, visibly small.

**Reason.** A kernel with twenty invariants and twenty passing tests wired to one finished
surface is a complete system. A kernel with four half-wired surfaces is an incomplete system
with more screens. The thinness of the other three *is* the argument for the kernel.

---

## ADR-015 — The aggregator-hosted tier is specified, not built

**Decision.** Document Shape C. Do not implement multi-tenancy.

**Reason.** Its entire premise is that Razorpay operates it — the merchant hands over nothing
because Razorpay already holds their key. It is a positioning argument, not code, and building
it would cost days for no evaluation benefit.


---

## ADR-016 — READ COMMITTED with an explicit row lock, not SERIALIZABLE

**Decision.** The authorisation transaction runs at `READ COMMITTED` and takes
`SELECT … FOR UPDATE` on the mandate row. Retry only `40P01` / `55P03`, three attempts, 10/40/160 ms
with jitter. Exhaustion returns `SYS-003`.

**Reason.** The row lock already serialises every authoriser for a mandate, and every read that
matters happens after it is held, so each statement sees committed data — exactly the guarantee
the cap needs. `SERIALIZABLE` adds predicate locking we do not use and generates `40001` storms
under the fifty-way concurrency test, which made that test's asserted shape unreachable.

**Rules out.** `SERIALIZABLE` on this path. Any read of `reservations` before the lock is held.

**Requires.** Any transaction moving a reservation *out of* `('held','captured')` must take the
mandate row lock, since it changes the cap sum. `held → captured` need not.

---

## ADR-017 — The executor is its own service

**Decision.** A sixth service, same image, `CMD` runs the executor, **no public ingress**. Kernel
and worker both call it over the internal network with a shared `EXECUTOR_TOKEN`.

**Reason.** The worker must call `orders.fetch` and `refunds.create`, which are authenticated
Razorpay calls — so either it holds the credential (breaking INV-02) or it proxies through a
process that does. Making the executor its own service means the credential never sits in a
process serving public HTTP, and `env | grep RZP` is provably empty in kernel, worker, web and
buyer-agent.

---

## ADR-018 — Two roles become three, and `agentkit_consent` is deleted

**Decision.** `agentkit_kernel`, `agentkit_worker`, `agentkit_console`, plus `agentkit_admin` used
only by the erasure CLI and held by no service.

**Reason.** `agentkit_consent` existed only because a separate Next.js app was assumed to grant
mandates. ADR-008 moved consent into the kernel and the role did not follow — which produced the
contradiction where a role with "zero ledger privilege" had to write the chain's genesis entry.

---

## ADR-019 — Step-up approval does not re-run the sequence

**Decision.** Approval runs a narrow locked transaction: re-check mandate live, reservation still
`held`, challenge valid and unconsumed; write an ALLOW decision; commit; execute.

**Reason.** The first pass burned the nonce and consumed the quote, so re-entering from the top
would fail on `INT-002`.

**Requires.** Quote TTL (10 min) must outlive challenge TTL (5 min).

---

## ADR-020 — A reservation is written at STEP_UP, not only at ALLOW

**Decision.** `held`, with TTL tied to the challenge. Released on expiry or rejection.

**Reason.** Otherwise an attacker issues many step-ups that reserve nothing, then approves them
in a burst against a cap that never saw them coming.

---

## ADR-021 — The nonce store is its own table, and the primary key is the burn

**Decision.** `intent_nonces (nonce PK, mandate_id, intent_id, burned_at)`. Burning is an
`INSERT`; a replay raises `23505` → `INT-002`.

**Reason.** No read-then-write, therefore no race. The agent-issued intent nonce and the
server-issued quote nonce have different issuers and lifecycles and do not share a table.

---

## ADR-022 — The cumulative window is rolling, not calendar

**Decision.** `created_at > now() - interval`. UX copy shows what is available now and when the
next tranche frees up.

**Reason.** A calendar month allows 2× the cap to be spent across a boundary.

---

## ADR-023 — Request rate and spend velocity are two different controls

**Decision.** `LMT-005` request rate lives at the edge, Postgres-backed so it survives multiple
instances, and never inside the transaction. `LMT-003` spend velocity is computed from
reservations inside the lock.

**Reason.** They were conflated as one "rate" check appearing on both sides of `BEGIN`.
