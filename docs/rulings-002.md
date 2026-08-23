# Rulings 002 — Phase 1 review

**Precedence: `rulings-002` > `rulings-001` > `CLAUDE.md` > everything else.**

All five items raised at the end of Phase 1 are approved. Three carry a refinement that
must be implemented before Phase 2 closes.

---

## 1 · `agentkit_owner` — approved, ADR-024

Correct, and the reasoning is the reason it must exist. A superuser bypasses RLS
unconditionally, so if the bootstrap superuser owned the tables there would be no
principal for whom `FORCE` means anything, and the INV-21 test would be vacuous **while
appearing to pass**. That is precisely the class of silent failure this project exists to
eliminate.

`NOSUPERUSER NOBYPASSRLS`, owns the twelve tables, no service connects as it.

**Refinement.** Add one more assertion to `rls.test.ts`: no role used by any service has
`BYPASSRLS`. Query `pg_roles` for `rolbypassrls` across `agentkit_kernel`,
`agentkit_worker`, `agentkit_console`, `agentkit_admin`, `agentkit_owner` and assert all
false. A future `ALTER ROLE … BYPASSRLS` would otherwise silently void INV-21 with every
existing test still green.

---

## 2 · The four grants — approved, ADR-018's matrix is amended

Each is an unavoidable consequence of a decision already taken, and none widens the trust
boundary.

| Grant | Forced by |
|---|---|
| kernel → `SELECT, INSERT` on `pseudonym_map` | ADR-018 moved consent into the kernel; granting a mandate must create the subject. No `UPDATE`, no `DELETE` — erasure stays with `agentkit_admin`. |
| worker → `SELECT` on `signing_keys` | Q-20 made anchors signed |
| worker → `DELETE` on `intent_nonces` | ADR-021 assigns nonce pruning to the worker |
| worker → `SELECT` on `ledger`, `ledger_anchor` | `verify-chain` reads before it anchors |

**Correction to `CLAUDE.md`'s deployment table.** The worker now holds the anchor signing
key, so "no secrets" is no longer accurate. State it precisely: *the worker holds the
anchor signing key and no payment credential.* INV-02 is about payment credentials and is
unaffected — but the table should not claim something untrue, and a reviewer will check.

The anchor key is deliberately low-value: forging an anchor cannot forge history, because
every per-mandate chain independently contradicts a false checkpoint.

---

## 3 · `quotes.categories` — approved, ADR-025

SCP-002 is unenforceable without it. The mandate grants categories; only the merchant's
own catalog knows which categories a basket touches; and the agent must not be the one to
say. Server-derived, in the signed payload, never agent-supplied. This extends the
documented Quote contract.

**Refinement — where the check lives.** Two places, deliberately, and they are not
redundant:

- **Quote service, at issue time:** refuse to issue a quote whose categories fall outside
  the mandate's scope. Fails fast, and gives the agent an actionable error before it
  builds an intent.
- **Policy engine, inside the lock:** assert `quote.categories ⊆ mandate.scope.categories`
  → `SCP-002`. **This is the enforcement point of record.** The quote-time check is
  ergonomics; the mandate could have been narrowed between issue and execution.

---

## 4 · Phase 1 built more than "schema and tests" — keep it. Do not gut it.

The instruction that both defining tests must fail on an unimplemented function rather
than a compile error forces exactly this. Fifty validly-signed intents cannot be
constructed without real JCS, real SHA-256, real Ed25519 and the real signing payloads.
Tests failing at fixture construction would prove nothing about the path they exist to
prove.

**The phase boundary is the decision path, not the line count.** Restated so this does not
become a licence:

> Anything pure, deterministic and policy-free that the defining tests genuinely need
> belongs in the phase that needs it. Anything that **decides** — reads mandate state,
> evaluates a rule, writes a reservation, moves money — belongs to its own phase and stays
> a stub until then.

Everything listed (JCS, hashing, Ed25519, Zod schemas, taint brands, `egress-guard.ts`,
`assert-no-credential.ts`) is on the correct side of that line. `authorize`, `evaluate`,
`verifier` and `append` being declared with full signatures and throwing is the right
shape.

---

## 5 · Money as a string in signed payloads — approved, ADR-026, with a required refinement

Correct on both counts: JCS constrains numbers, and a string removes any question of how a
serialiser rendered the value. TypeScript keeps `bigint` throughout.

**Refinement, and this one is load-bearing.** The string must be canonical, or the same
amount produces two different hashes and signature verification becomes
position-dependent:

```
^(0|[1-9][0-9]*)$
```

Integer paise only. No leading zeros, no sign, no decimal point, no exponent, no thousands
separator. `"0042"` and `"42"` must not both be accepted for 42 paise — reject the former
**at parse time** in the Zod schema, not at compare time.

Add a test: a payload built with a non-canonical amount string fails schema validation
before it can be signed.

---

## Smaller rulings

**The `SET LOCAL` finding is elevated to a documented hazard.** `SET LOCAL` outside a
transaction is a silent no-op, and on a pooled connection that makes an RLS test pass
because the data was *invisible* rather than *isolated*. That is the exact failure shape
this project is about, and it will reach the kernel's request middleware in Phase 2.

**Required in Phase 2:** the middleware that sets the merchant context must assert a
transaction is open before setting it, and throw if not. Silent no-op is not an acceptable
failure mode for a tenant-isolation control. Use `set_config(..., is_local => true)`
inside an explicit `BEGIN`, as the harness now does.

**npm, not pnpm.** Settled now rather than at Phase 5. npm workspaces are sufficient, and
`corepack enable` needing sudo is precisely the friction that costs a judge ten minutes on
a fresh machine. Amend the stack note in `CLAUDE.md` and `architecture.md`.

**One Testcontainers container per run, a database per suite.** Approved and worth keeping
as a standing rule — 25s to 3.6s, and a reaper race is flakiness a judge reads as broken.

**SEC-001 deferred to the Phase 6 red-team suite.** Correct. Taint tagging happens at the
HTTP edge, which does not exist yet. The injection case that *is* testable now — an
injected rationale changing nothing about the verdict — is the right thing to have
covered.

**INV-02's compose half deferred to Phase 5.** Correct. The code-level boot assertion is
the half that can exist now, and it does.

**Deferred tables acknowledged:** `challenges` (ADR-019/020) and `rate_limit_buckets`
(ADR-023). Neither is reachable in Phase 1.

---

## Doc corrections

- `security-invariants.md` INV-21: `002_rls.sql` → **`004_rls.sql`**. Migrations are
  numbered by dependency order and RLS lands fourth.
- INV-11's `001_ledger.sql` is correct as written.
- INV-05 → `kernel/authorize.ts` and INV-19 → `kernel/egress-guard.ts` are correct and
  both files exist.
- `CLAUDE.md` deployment table: the worker holds the anchor signing key, not nothing.
- `CLAUDE.md` stack note: npm, not pnpm.

---

## Phase 2 is authorised

Mandates, the policy engine, and the locked transaction — until the concurrency test is
green **without either test file being touched**.

Order within the phase, so the hardest thing is proved first:

1. The transaction wrapper in `kernel/authorize.ts` — `BEGIN READ COMMITTED`, `FOR
   UPDATE`, `lock_timeout`, the retry loop on `40P01`/`55P03`, `SYS-003` on exhaustion.
2. The cap read over reservations, and the reservation write, inside it.
3. **Stop and run the concurrency test.** It should go green here, before a single policy
   rule exists beyond `LMT-002`. If it is green at this point, INV-05 is real.
4. Then the rest of the rule set, the `evaluated[]` trace, and fail-closed.
5. Then mandate issue and revoke, with revoke taking the identical lock.

Stop at the end and show me `authorize.ts`, `evaluate.ts`, and the concurrency test
output.

**Still open and still mine:** Reserve Pay on the test account. Does not block Phase 2.
