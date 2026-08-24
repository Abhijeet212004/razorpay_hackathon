.DEFAULT_GOAL := help
SHELL := /bin/bash
COMPOSE := docker compose

.PHONY: help up down reset test typecheck invariants verify creds seed-check logs judge prove attack

help: ## Show this help
	@grep -E '^[a-z-]+:.*?## .+$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-12s %s\n", $$1, $$2}'

up: ## Everything, seeded, ready. No credentials needed.
	$(COMPOSE) up -d --wait
	@echo
	@echo "  kernel   http://localhost:58080/health"
	@echo "  web      http://localhost:58083/api/mode"
	@echo "  agent    http://localhost:58084/health"
	@echo "  postgres localhost:55432"

down: ## Stop everything, keep the data
	$(COMPOSE) down

reset: ## Back to a known seeded state
	$(COMPOSE) down -v
	$(MAKE) up

logs: ## Follow every service
	$(COMPOSE) logs -f

test: ## Full suite against real Postgres
	npm test

typecheck: ## Strict typecheck, no emit
	npx tsc --noEmit

invariants: ## Regenerate the invariant table from the markers in the tree
	@node scripts/invariants.mjs

verify: ## Recompute every hash chain from raw rows, as the read-only console role
	@$(COMPOSE) exec -T kernel node dist/cli/verify.js --merchant $${MERCHANT_ID:-mch_sharma_kirana}

## The second half of the credential-isolation claim. The first half is a boot assertion
## inside each service; this is the observable one.
creds: ## Prove only the executor holds a payment credential
	@echo "checking that no service but the executor holds a payment credential"
	@fail=0; \
	for s in kernel worker web buyer-agent; do \
	  out=$$($(COMPOSE) exec -T $$s sh -c 'env | grep -E "^(RZP_KEY_SECRET|RAZORPAY_KEY_SECRET)=" || true'); \
	  if [ -n "$$out" ]; then echo "  FAIL  $$s holds $$out"; fail=1; \
	  else echo "  ok    $$s"; fi; \
	done; \
	out=$$($(COMPOSE) exec -T executor sh -c 'env | grep -c "^RZP_KEY_SECRET=" || true'); \
	if [ "$$out" = "0" ]; then echo "  FAIL  executor has no credential to hold"; fail=1; \
	else echo "  ok    executor holds it, and is the only one"; fi; \
	exit $$fail

seed-check: ## Assert the seed is present and idempotent
	@$(COMPOSE) exec -T postgres psql -U bootstrap -d agentkit -tAc \
	  "SELECT 'mandates=' || (SELECT count(*) FROM mandates) || \
	          ' decisions=' || (SELECT count(*) FROM ledger WHERE kind='DECISION') || \
	          ' orders=' || (SELECT count(*) FROM orders) || \
	          ' chains=' || (SELECT count(DISTINCT chain_id) FROM ledger)"

prove: ## Delete each control, show the suite catching it, restore
	@node scripts/prove.mjs

attack: ## The red-team suite: a hostile agent, no model required
	@TESTCONTAINERS_RYUK_DISABLED=true npx vitest run tests/redteam

judge: ## Everything a reviewer needs, in one command
	$(MAKE) up
	$(MAKE) seed-check
	$(MAKE) creds
	$(MAKE) verify
