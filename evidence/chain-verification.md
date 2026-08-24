# Chain verification

Every hash recomputed from the raw rows, as the read-only console role. Nothing here
trusts a stored hash: each entry is re-derived from its predecessor and its canonical
payload, so a row edited in place is caught even when its hash column was edited to match.

```
merchant mch_sharma_kirana
  ok      mnd_1712aea4-d9ac-460f-98db-f815b853393e  16 entries
  ok      mnd_32780091-aeb0-4979-9d71-b16a3a39d55f  23 entries
  ok      mnd_34f45719-a758-4240-9d65-64904f842b7f  1 entries
  ok      mnd_arjun  20 entries
  ok      mnd_d70b2fc9-ed8c-4936-a04f-c7f43240b310  5 entries
  ok      mnd_meera  17 entries
  ok      mnd_priya  135 entries
  7 chains verified, every hash recomputed from raw rows
```

## Tampering with it

```
$ docker compose exec postgres psql -U bootstrap -d agentkit \
    -c "UPDATE ledger SET payload_redacted = jsonb_set(payload_redacted, '{payload,amount_paise}', '\"999999\"') WHERE chain_id = 'mnd_priya' AND seq = 4"
UPDATE 1

$ make verify
merchant mch_sharma_kirana
  ok      mnd_1712aea4-d9ac-460f-98db-f815b853393e  16 entries
  ok      mnd_32780091-aeb0-4979-9d71-b16a3a39d55f  23 entries
  ok      mnd_34f45719-a758-4240-9d65-64904f842b7f  1 entries
  ok      mnd_arjun  20 entries
  ok      mnd_d70b2fc9-ed8c-4936-a04f-c7f43240b310  5 entries
  ok      mnd_meera  17 entries
  BROKEN  mnd_priya  135 entries  first break at seq 4
  1 of 7 chains FAILED verification
make: *** [verify] Error 1
```
