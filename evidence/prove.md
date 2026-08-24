# make prove

Each control is deleted, only the test that exists to catch it is re-run, then it is
restored. A test that stays green after its control is removed was decorative.

```
  removing row lock on the mandate ... caught
  removing reservation counted in the cap ... caught
  removing FORCE row level security ... caught
  removing quote bound to its mandate ... caught
  removing append-only ledger grants ... caught
  removing hash recomputed from raw rows ... caught
  removing nonce burn ... caught

| control removed                | test | result |
|--------------------------------|------|--------|
| row lock on the mandate        | security/concurrency | went red |
| reservation counted in the cap | security/concurrency | went red |
| FORCE row level security       | infra/rls | went red |
| quote bound to its mandate     | security/compromised-model | went red |
| append-only ledger grants      | infra/grants | went red |
| hash recomputed from raw rows  | security/chain | went red |
| nonce burn                     | security/compromised-model | went red |

7 controls removed, 7 tests went red. None are decorative.
```
