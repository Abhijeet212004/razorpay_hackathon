# agentkit-merchant

Server-side SDK for integrating an AgentKit trust kernel.

```
pip install agentkit-merchant
```

Requires Python 3.9 or newer. The only dependency is `cryptography`.

## Why not just call the HTTP API

You can, and the API is documented. But three details are unforgiving, and all three fail
the same way: the kernel answers `INT-001`, meaning *this signature does not match this
payload*, and deliberately says no more. A signature check that explained itself would be
an oracle for forging one.

1. **Canonical JSON.** Signatures cover RFC 8785 bytes. Key order, escaping and number
   formatting all have to match the kernel exactly.
2. **Money is a string.** `amount_paise` is signed as a decimal string, never a JSON
   number or a float. This package refuses floats rather than rounding them.
3. **The signing payload is a closed set.** Ten named fields for an intent, nine for a
   quote. An extra key changes the bytes; so does a missing one.

## Quick start

```python
from agentkit import AgentKit

kit = AgentKit(
    base_url="https://kernel.yourshop.in",
    api_key=os.environ["AGENTKIT_API_KEY"],
)

public, private = AgentKit.generate_key_pair()
agent_id = kit.register_agent("Shop Assistant", public)
# Persist agent_id and private. See "Identity is not a cache" below.

found = kit.search_catalog(mandate_id, "rice")
item = next(i for i in found["items"] if i["in_scope"])

signed_quote = kit.quote(mandate_id, [{"sku": item["sku"], "quantity": 1}])

agent = kit.agent(agent_id, private)
decision = agent.checkout(mandate_id, signed_quote, rationale="weekly staples")

if decision["verdict"] == "ALLOW":
    ...  # decision["pay_url"], decision["audit_url"]
elif decision["verdict"] == "STEP_UP":
    ...  # send the shopper to decision["approval_url"]
```

## Two credentials, two doors

| Option | Header | Who holds it | What it opens |
| --- | --- | --- | --- |
| `api_key` | `x-agentkit-key` | The agent | Catalog, quotes, checkout, orders |
| `fulfil_token` | `x-agentkit-token` | Your backend only | Binding a consent request to a real customer |

`fulfil_token` also signs authorization tokens. **Never ship it to an agent.** A call
through the agent door never carries it, and there is a test for exactly that.

## Identity is not a cache

A mandate is granted to an agent id derived from a public key. Generate a fresh keypair on
each deploy and every mandate a shopper ever granted you is orphaned on the next restart,
refused with `MND-001` and nothing on screen to explain why.

Store `agent_id` and the private key in your database and load them at boot. The private
key is a signing key, never a payment credential: the worst an attacker who steals it can
do is propose purchases, which still have to pass the mandate and every policy rule.

## Refusals are answers

```python
from agentkit import AgentKitRefusal, AgentKitError

try:
    decision = agent.checkout(mandate_id, signed_quote)
except AgentKitRefusal as exc:
    # The kernel decided. exc.reason_code is stable and safe to branch on.
    if exc.reason_code == "CAP-001":
        notify_shopper_cap_reached()
except AgentKitError:
    # The transport failed. Nothing was decided; retrying is safe.
    ...
```

Common codes: `MND-001` no live mandate, `CAP-001` cap exhausted, `SEC-002` unknown agent,
`INT-001` signature mismatch, `INT-003` amount or basket differs from the quote.

## Consent

The agent supplies neither the customer nor the address, and never learns either.

```python
consent = kit.request_consent(
    agent_id=agent_id,
    contact=shopper.phone,
    requested_scope={"merchants": ["mch_yourshop"], "categories": ["groceries"], "currency": "INR"},
    limits={
        "per_transaction_paise": "500000",
        "cumulative_paise": "1500000",
        "silent_threshold_paise": "50000",   # above this, the shopper is asked
        "velocity_per_hour": 3,
    },
)
```

Then, from a route that can read your session:

```python
@app.post("/agent/authorize")
@login_required
def authorize():
    address = Address.query.filter_by(
        id=request.form["address_id"],
        user_id=current_user.id,        # theirs, not just any id posted
    ).first_or_404()

    token = kit.authorization_token(
        ref=request.form["ref"],
        customer_ref=current_user.id,   # session, always
        fulfilment_ref=address.id,
        display_name=current_user.name,
        display_address=format_address(address),
    )
    return redirect(kit.consent_url(request.form["ref"], token))
```

The display fields are the point. You cannot prove to the kernel that this customer id is
this person, because it is your namespace and opaque to them. So the kernel shows the
shopper the name and address you claim and lets them decline if it is not theirs.

The signing key is the SHA-256 of your fulfil token, not the token itself. The kernel
stores only that hash, so it can verify your handoffs without ever holding your token in a
recoverable form, and every merchant ends up with a distinct key. The SDK does this for
you.

## Reading what happened

```python
record = kit.audit(decision["intent_id"])
print(record["chain_intact"])
for entry in record["entries"]:
    print(entry["kind"], entry["seq"], entry["detail"])
```

Needs no credential: the reader is usually a shopper or a support desk, and neither holds
a key. The intent id is a random UUID, so knowing it is the capability.

Two rules that page must keep: bind on POST, never GET, or a link or a prefetch can grant
consent; and take the customer from the session, never the request body.

## Decimal, not float

`amount_paise` arrives as a string of integer paise. Dividing a float by 100 will
eventually give you an order worth ₹63.99999999999999.

```python
from decimal import Decimal
total = Decimal(order["amount_paise"]) / 100
```

## Tests

```
python -m pytest tests/
```

## Licence

Apache-2.0
