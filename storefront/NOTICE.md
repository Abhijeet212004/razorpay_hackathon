# Third-party code

`storefront/` is adapted from an open-source MIT-licensed e-commerce template. The
original copyright notice is retained in `storefront/LICENSE` as the licence requires.

We changed it in three ways: the payment lane was moved to Razorpay, an agent lane was
added at `/agent`, and the admin dashboard gained an **Agent Activity** section.

Everything under `src/`, `migrations/`, `tests/` and `scripts/` in the repository root —
the trust kernel, the policy engine, the ledger, the executor and the test suite — is
ours.
