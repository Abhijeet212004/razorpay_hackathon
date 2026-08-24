# The bug the fifty-way test found

## Three sentences for the README

In PostgreSQL, `ORDER BY` binds to an output column name in preference to the underlying
column — unlike `WHERE`, which does not — so aliasing a cast to the same name silently
turns a numeric sort into a lexicographic one. Our ledger head query did exactly that, and
every hash chain built correctly until it reached ten entries, at which point `'9'` sorted
above `'10'` and every subsequent append computed a stale predecessor. Every isolated
probe passed; only the fifty-concurrent-intent test found it, which is the argument for
writing the defining tests before the kernel stated as a fact rather than a principle.

## The query

```sql
-- Wrong. The cast produces an output column also named `seq`, and ORDER BY binds to it.
SELECT chain_id, seq::text, prev_hash, hash, kind
  FROM ledger WHERE chain_id = $1 ORDER BY seq DESC LIMIT 1;

-- Right. The alias breaks the capture, and qualifying the sort names the bigint column.
SELECT chain_id, seq::text AS seq_text, prev_hash, hash, kind
  FROM ledger WHERE chain_id = $1 ORDER BY ledger.seq DESC LIMIT 1;
```

`seq` is `BIGINT`. It is cast to text because a JavaScript number cannot carry a 64-bit
integer safely. That cast is correct; naming its result `seq` is what broke the sort.

## What it looked like

Fifty concurrent intents against one mandate. Forty-five failed on
`duplicate key value violates unique constraint "ledger_pk"`. Instrumenting the append
showed the shape immediately:

```
pid=78 kind=INTENT       seq=0  rows=0
pid=78 kind=DECISION     seq=1  rows=1
pid=78 kind=RESERVATION  seq=2  rows=2
pid=73 kind=INTENT       seq=3  rows=3
...
pid=99 kind=DECISION     seq=10 rows=10
pid=81 kind=INTENT       seq=10 rows=11     <- head read as 9 while 11 rows existed
pid=89 kind=INTENT       seq=10 rows=11
pid=74 kind=INTENT       seq=10 rows=11
```

Text-ordered descending, `[0..10]` sorts as `9, 8, 7, 6, 5, 4, 3, 2, 10, 1, 0`. The head
is `'9'`, so every later append computed `seq = 10` and collided.

## Why the isolated probes missed it

Three separate probes were written while chasing this, and all three passed:

| Probe | Result | Why it missed |
|---|---|---|
| 8 concurrent transactions, real lock, real inserts | passed | never reached ten entries |
| Two clients, one holding `FOR UPDATE` | passed | proved the lock blocks, which was never the problem |
| 50 concurrent transactions incrementing a counter | passed | the counter table has no `seq` column to mis-sort |

The row lock was correct throughout. Lock acquisition timestamps were strictly ordered and
three to four milliseconds apart. Every component behaved; the defect was in how one query
was written, and it only became visible past a data threshold no unit test crossed.

## What this is evidence of

The concurrency test was written in Phase 1, before any kernel existed, and its shape was
fixed by the invariant rather than by the implementation: fifty intents, one unit of
headroom, no webhooks delivered. Nothing about that shape was chosen to catch a
lexicographic sort. It caught one anyway, because fifty is past ten.

A test written after the implementation would have been written against a chain that
already worked, and would very likely have used five intents.
