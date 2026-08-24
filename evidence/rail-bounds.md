# The bounds are layered, and only the inner ones are ours

Two of these are enforced by NPCI and Razorpay, independently of anything we run. Three
are ours. The claim that a policy mandate can only ever be narrower than the rail
authority is checkable rather than asserted: the outer bounds are visible on the
merchant's own Razorpay settings page.

| Bound | Set by | Value |
|---|---|---|
| Rail ceiling | NPCI / Razorpay | ₹1,00,000 per mandate |
| Rail PIN threshold | NPCI / Razorpay | ₹15,000 |
| **Policy silent threshold** | our mandate | **₹500** |
| Policy per-transaction cap | our mandate | ₹5,000 |
| Policy cumulative | our mandate | ₹15,000 per 30 days |

Razorpay's own wording on the payment-methods page: *"UPI — Accept payments upto
₹1,00,000. Payments above ₹15,000 will ask the customer for UPI PIN verification as
well."*

## Operational constraint for demos

**Every demo amount must stay below ₹15,000.** Above it the rail forces a PIN, and a
viewer would see a PIN prompt and reasonably conclude our silent path does not work — when
what they were actually watching was NPCI's threshold, not ours.

The step-up in the user journey is ₹1,240. That is **our** policy firing at ₹500, not the
rail firing at ₹15,000. Picking a ₹20,000 demo amount later would make the two
indistinguishable.

## Rail capability confirmed

`POST /v1/orders` with `token.frequency = "as_presented"` and a `max_amount` is accepted
on the test account, which is variable-amount charge-on-demand. Recorded in
`fixtures/razorpay/orders.create.token.as_presented.json`.
