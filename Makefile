.PHONY: test typecheck invariants verify

test:
	npm test

typecheck:
	npx tsc --noEmit

# Regenerates the invariant table's file:line column from the INV-NN markers in the tree.
invariants:
	@node scripts/invariants.mjs

# Recomputes every hash chain from raw rows, as the read-only console role.
verify:
	@node --experimental-strip-types src/cli/verify.ts --merchant $(MERCHANT_ID)
