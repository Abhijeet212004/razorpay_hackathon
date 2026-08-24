# The concurrency test, ten consecutive runs

Fifty concurrent intents against ₹900 of headroom, no webhooks delivered. Exactly one
ALLOW, forty-nine LMT-002, and SUM(held) = 90000 paise. Nine out of ten would be broken.

```
run  1   Tests 4 passed (4)
run  2   Tests 4 passed (4)
run  3   Tests 4 passed (4)
run  4   Tests 4 passed (4)
run  5   Tests 4 passed (4)
run  6   Tests 4 passed (4)
run  7   Tests 4 passed (4)
run  8   Tests 4 passed (4)
run  9   Tests 4 passed (4)
run 10   Tests 4 passed (4)
```
