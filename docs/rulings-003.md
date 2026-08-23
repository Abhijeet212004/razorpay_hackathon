# Rulings 003 — the three dashboards, and Phase 2 review

**Precedence: `rulings-003` > `rulings-002` > `rulings-001` > `CLAUDE.md` > everything else.**

---

# Part 1 — There are three dashboards, and only two are ours

The word "dashboard" has been covering three different products. Naming them separately
settles the question.

| | Whose | Scope | Built by us? |
|---|---|---|---|
| **Razorpay Dashboard** | Razorpay's existing product | One merchant's payments — orders, settlements, refunds | **No.** It already exists. We only put `intent_id` in the order's `notes` so it round-trips into ours. |
| **Merchant console** | Ours | One merchant's agent activity — ledger, rule traces, mandates, denials, chain | **Yes.** Ships inside the image. |
| **Operator console** | Ours | Every merchant, in aggregate | **Yes, but one page.** See below. |

The Razorpay Dashboard answers *did the money move*. The merchant console answers *why was
it allowed to*. They are deliberately different questions, and the `intent_id` in `notes`
is the join between them — that round trip is the strongest thirty seconds in the
submission.

---

## ADR-027 — The merchant console is one build, deployed three ways

**Decision.** The merchant console is part of the kernel image. It is not a separate
product for self-hosted and hosted merchants.

- **Shape A / B** (SDK or Docker): the merchant runs it themselves, on their own domain,
  scoped by `agentkit.merchant_id` to their own rows. Nothing is sent anywhere.
- **Shape C** (aggregator-hosted): Razorpay serves the same console per merchant under
  `razorpay.com`, scoped identically.

**Reason.** Same principle as the kernel itself — one image, three shapes, only the
operator changes. Building a "local" and a "hosted" console separately would double the
surface and guarantee they drift.

**Rules out.** A self-hosted merchant phoning home. In Shapes A and B nothing about their
ledger leaves their infrastructure, and that is part of the adoption argument.

---

## ADR-028 — The operator console reads health, never history

**Decision.** Build an operator console, but it sees **aggregates only** — never a ledger
row, never a rule trace, never another merchant's transaction detail.

This is the Shape C product and the answer to "what does Razorpay's side look like." It is
also where the security design is most easily wrecked, so the constraint is strict.

### The problem it creates

A cross-merchant view wants to read across every merchant. That is precisely what INV-21
forbids, and `rls.test.ts` already asserts that no `agentkit%` role has `BYPASSRLS`.

Granting the operator console `BYPASSRLS` is not an option. It would void INV-21 while
every existing test stayed green — the exact failure shape this project exists to
eliminate.

### The resolution

A worker job iterates merchants, setting `agentkit.merchant_id` per merchant, and writes
per-merchant aggregates into `operator_metrics`. RLS holds for every read. The operator
console reads only that table.

```sql
CREATE TABLE operator_metrics (
  merchant_id        TEXT NOT NULL,
  window_start       TIMESTAMPTZ NOT NULL,
  decisions_total    BIGINT NOT NULL,
  denials_total      BIGINT NOT NULL,
  denials_by_code    JSONB NOT NULL,     -- counts only, no ids
  gmv_paise          BIGINT NOT NULL,
  active_mandates    INT NOT NULL,
  reservations_held  BIGINT NOT NULL,
  chain_status       TEXT NOT NULL,      -- 'ok' | 'broken'
  breaker_trips      INT NOT NULL,
  refreshed_at       TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (merchant_id, window_start)
);
```

No identifiers of any kind — no `intent_id`, no `mandate_id`, no pseudonyms, no amounts
attributable to a transaction. Counts and sums.

### Drilling in is possible, and it is audited

An operator who needs a specific merchant's detail must **impersonate** — set that
merchant's context explicitly — and that action **writes a ledger entry to that merchant's
operations chain** (see Part 2, item 2).

The merchant can see, in their own console, every time the operator looked at their data.

That is a genuinely strong property and worth saying out loud in the pitch: *even the
party operating the guard layer cannot browse a merchant's ledger without leaving a
permanent, merchant-visible record.*

### What to actually build — one page, half a day

Do not build an operations product. Build the argument.

- **Four tiles:** merchants live · decisions in 24h · denial rate · chains healthy
- **One table:** merchant · decisions · denial rate · GMV · active mandates · chain status
- **One thing that moves:** the breaker-trip / broken-chain alert row
- **The impersonate button**, which writes the audit entry — this is the point of the page

Everything else is Phase 7 or never. Its job is to make Shape C concrete for a reader, not
to run a business.

---

# Part 2 — Phase 2 review

## 1 · `SEC-004` — ratified

Correct. Overloading `SEC-001` (tainted content) or `SEC-002` (unregistered agent) would
make the `evaluated[]` trace lie about what happened, and the trace is the product.

**Refinement.** `SEC-004` is the one denial a user may need to act on, so its agent-facing
shape matters more than most:

```json
{ "reason_code": "SEC-004",
  "explanation": "That didn't look like what you asked for, so I stopped.",
  "recoverable": true,
  "suggested_actions": ["restate_request", "confirm_manually"] }
```

**Never surface the verifier's own reasoning to the agent** — that is an oracle for tuning
attacks against it.

---

## 2 · `MND-001` and `SYS-003` write no ledger entry — real gap, and the fix is small

You are right that this breaks INV-10, and right not to paper over it. Both cases are
unchainable for the same reason: no mandate chain exists, or the lock that serialises
appends to it could not be taken.

**Ruling: add a per-merchant operations chain.** `chain_id = merchant_id`. No schema
change — `chain_id` is already `TEXT` and carries no foreign key.

It carries every decision that has no mandate chain to live on:

| | |
|---|---|
| `MND-001` | unknown mandate — merchant is known from the endpoint and the intent |
| `SYS-003` | lock exhausted — the mandate is known but its chain cannot be appended to |
| `LMT-005` | rate limit tripped at the edge, before any mandate is resolved |
| breaker trips | global spend-velocity halt |
| operator impersonation | ADR-028 — this is what makes that audit trail possible |

Appends to the operations chain serialise on the **merchant** row, not a mandate row.

INV-10 becomes true again without exception, and ADR-028's audit property becomes
implementable. One fix, two problems.

---

## 3 · Fail-closed swallowing bugs — keep the behaviour, make it loud

The tradeoff is real and INV-08 demands the behaviour. But a silent `SYS-001` is a bug
that never gets found.

**Required:**

- Log at `error` with the full stack and a **distinct counter** — `SYS-001` from an
  unexpected error must be distinguishable in metrics from `SYS-001` from a known
  dependency failure.
- Put an `error_class` (the constructor name) in the ledger payload. **Never the
  message** — messages carry PII and this is an append-only table.
- **In test and development, re-throw instead of swallowing.** A bug should crash a test
  run, not quietly deny.
- And **exactly one test that runs in production mode**, injects an unexpected error, and
  asserts `SYS-001` — so the fail-closed path itself stays covered.

Fail closed in production, fail loud in development. Both, not either.

---

## 4 · `STP-003` not implemented — correct, and say so

Leave it. Keep the code reserved in the enum, never emit it, and list it in the README's
"specified but not implemented" section alongside the `INV-xx` rows still at `ENFORCED`.

A reserved code that is honestly declared unimplemented is fine. A history model faked in
a weekend to light it up would be the mistake.

---

## On the two bugs

**The `seq::text` bug is the best thing in this phase, and it belongs in `evidence/`.** In
PostgreSQL, `ORDER BY` binds to an output column name in preference to the underlying one
— unlike `WHERE`, which does not — so aliasing a cast to the same name silently changes
the sort to lexicographic. Invisible below ten rows. Every isolated probe passed. Only the
fifty-way test found it.

That is the argument for writing the defining tests first, stated as a fact rather than a
principle. Write it up in three sentences for the README.

**On editing the test.** The rule is precise: **the assertion is sacred; the fixture and
the verification query are code and can be fixed.** Correcting an `ORDER BY` in a test's
own verification query is fixing a bug in the test's instrument, not weakening its claim.
Flagging it was right, and keep flagging every one.

**The `burnNonce` SAVEPOINT is a good catch on your own work.** A constraint violation
aborts the entire transaction in PostgreSQL, so catching it and continuing would have
poisoned every later statement — the denial could never have been written. That the
nonce-replay attack now passes *because of* the savepoint is the tell that it was
load-bearing.

---

## Phase 3 authorised

Identity, quotes, the ledger chain, and `agentkit verify` recomputing every hash from raw
rows.

**Add to the phase:** the operations chain from item 2 above, since the ledger work is
here and `MND-001` needs it.

**Two standing items:** `docs/rulings-002.md` was sent and is not in the repo — save it,
along with this file. And the invariant table's `file:line` column should now be generated
by `make invariants` rather than maintained by hand, since the restructure has already
made several paths stale.

**Still open and still mine:** Reserve Pay on the test account.
