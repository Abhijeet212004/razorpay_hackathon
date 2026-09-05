# @agentkit/adapter

A container beside your application that translates your existing endpoints into the three
contracts AgentKit needs. No application code changes.

```
kernel   ->  GET  /catalog    ->  your products endpoint
kernel   ->  POST /fulfil     ->  your orders endpoint
shopper  ->  GET  /authorize  ->  your session endpoint
```

## When to use it

When your products, orders and session endpoints already exist and you would rather
configure than write code.

When you *can* change your application, integrate directly with `@agentkit/merchant`
instead. It is fewer moving parts and gives you the decision object rather than a
translation of it.

## What it is not

A translator, and only that. It holds no permission, no limit and no ledger, and it makes
no decision. Those stay in the kernel, which is what makes them something a compromised
merchant cannot quietly rewrite.

It sits on your network and holds your fulfilment token, so treat it as part of your
application rather than as a third party service. It never needs inbound access from the
internet.

## Run it

```yaml
services:
  agentkit-adapter:
    image: ghcr.io/abhijeet212004/agentkit-adapter:1
    restart: unless-stopped
    environment:
      AGENTKIT_BASE_URL:     https://kernel.yourshop.in
      AGENTKIT_FULFIL_TOKEN: ${AGENTKIT_FULFIL_TOKEN}
      AGENTKIT_API_KEY:      ${AGENTKIT_API_KEY}

      # your existing endpoints, on the internal network
      MERCHANT_PRODUCTS_URL: http://app:3000/api/products
      MERCHANT_ORDERS_URL:   http://app:3000/api/orders
      MERCHANT_SESSION_URL:  http://app:3000/api/me

      # your field names
      PRODUCTS_ROOT:      data.items
      PRODUCT_ID:         id
      PRODUCT_NAME:       title
      PRODUCT_CATEGORY:   category.name
      PRODUCT_PRICE:      price.amount
      PRODUCT_PRICE_UNIT: paise
      PRODUCT_STOCK:      inventory.count
    ports:
      - "7000:7000"
    depends_on:
      - app
```

Then point AgentKit at the adapter rather than at your app:

| Setting | Value |
| --- | --- |
| Catalog URL | `http://agentkit-adapter:7000/catalog` |
| Fulfilment URL | `http://agentkit-adapter:7000/fulfil` |
| Authorisation URL | `https://yourshop.in/agent/authorize` (proxied to the adapter) |

It refuses to start if a required setting is missing, so a typo fails at boot rather than
mid purchase.

## Mapping your fields

Every mapping is a dotted path into your own response. Array indices are numeric segments,
so `variants.0.price` works.

### Products

| Variable | Default | What it points at |
| --- | --- | --- |
| `PRODUCTS_ROOT` | `products` | Where the array lives. Empty if the response *is* the array. |
| `PRODUCT_ID` | `_id` | Stable id. This is the SKU a quote will name. |
| `PRODUCT_NAME` | `name` | |
| `PRODUCT_DESCRIPTION` | `description` | Scanned for prompt injection, then quarantined if it matches. |
| `PRODUCT_CATEGORY` | `category` | Lowercased. Mandate scopes are matched against it. |
| `PRODUCT_PRICE` | `price` | |
| `PRODUCT_PRICE_UNIT` | `rupees` | Or `paise`. |
| `PRODUCT_STOCK` | `stock` | |

> **`PRODUCT_PRICE_UNIT` is the one to get right.** A price of `499` means ₹499 or ₹4.99
> depending on this setting. There is no way to infer it, which is why it is configuration
> rather than a guess. Check one product in `/catalog` before you go live.

A row with no id is dropped rather than given a made up one, because a SKU that changes
between syncs makes every prior quote unresolvable. A row that fails to map is skipped and
logged; one bad product does not take the catalog down.

### Orders

| Variable | Default |
| --- | --- |
| `ORDER_CUSTOMER_FIELD` | `customer_ref` |
| `ORDER_ADDRESS_FIELD` | `fulfilment_ref` |
| `ORDER_ITEMS_FIELD` | `items` |
| `ORDER_REFERENCE_FIELD` | `intent_id` |
| `ORDER_PAYMENT_FIELD` | `payment_id` |
| `ORDER_AMOUNT_PAISE_FIELD` | `amount_paise` |
| `ORDER_AMOUNT_RUPEES_FIELD` | unset |
| `ORDER_PLACED_BY_FIELD` | `placed_by` |
| `ORDER_ID_RESPONSE_FIELD` | `order_id` |

Set `ORDER_AMOUNT_RUPEES_FIELD` if your schema stores rupees. The value is computed as a
string with exactly two decimal places, never a float: `6399` paise becomes `"63.99"`.

Targets may be nested. `ORDER_CUSTOMER_FIELD=user.id` produces `{"user":{"id":"..."}}`.

### Session

Your session endpoint is called with the shopper's own cookie forwarded, and must return
who they are and where they may ship.

| Variable | Default |
| --- | --- |
| `SESSION_ID_FIELD` | `id` |
| `SESSION_NAME_FIELD` | `name` |
| `SESSION_ADDRESSES_FIELD` | `addresses` |
| `ADDRESS_ID_FIELD` | `id` |
| `ADDRESS_LINE_FIELD` | `line` |

Leave `MERCHANT_SESSION_URL` unset to disable `/authorize` and host that page yourself.

## Idempotency is still yours

The adapter forwards every fulfilment call it is given. It does not deduplicate, because
only your database knows whether an order already exists.

The kernel retries. Make your orders endpoint idempotent on `ORDER_REFERENCE_FIELD` and
return the existing order, or a shopper eventually gets two.

## Two rules /authorize keeps

Both are real holes if dropped, and both are enforced here rather than left to you.

1. **GET renders, POST commits.** Binding consent on a GET makes it reachable by a link, an
   image tag or a browser prefetch.
2. **The customer comes from your session endpoint, never from the request body.** A posted
   `address_id` is checked against the list your endpoint returned rather than trusted.

The redirect target is built from `AGENTKIT_BASE_URL` and never echoed from a query
parameter, which would make the route an open redirect.

## Verify

```
curl -s localhost:7000/health
curl -s localhost:7000/catalog | head -c 400
```

Check the first product: the id is what you expect, the category is one your mandates
actually scope to, and the price is in rupees at the right magnitude.

```
docker compose --profile adapter up -d adapter
```

## Tests

```
npm test
```

## Licence

Apache-2.0
