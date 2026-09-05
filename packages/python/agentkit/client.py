"""A client for one merchant's AgentKit kernel.

Two credentials, two doors, and they are not interchangeable. `api_key` opens the agent
door, which is the surface a third-party agent is given. `fulfil_token` opens the merchant
door, which binds a consent request to a real customer and address, and is the secret your
own backend holds. Never ship the fulfil token to an agent.
"""

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone

from .errors import AgentKitError, AgentKitRefusal
from .keys import generate_key_pair, sign_payload, verify_payload
from .payloads import intent_signing_payload, quote_signing_payload

DEFAULT_TIMEOUT = 15.0
DEFAULT_INTENT_TTL_MS = 120_000
DEFAULT_TOKEN_TTL_MS = 600_000


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


class Agent:
    """A registered agent that can sign intents.

    Holds a signing key and nothing else: no payment credential and no standing authority.
    Every purchase it proposes is checked against the mandate at the moment of the call.
    """

    def __init__(self, kit: "AgentKit", agent_id: str, private_key):
        self.kit = kit
        self.agent_id = agent_id
        self.private_key = private_key

    def sign_intent(self, intent) -> str:
        return sign_payload(self.private_key, intent_signing_payload(intent)).hex()

    def checkout(self, mandate_id: str, signed_quote, rationale: str = "", intent_ttl_ms=DEFAULT_INTENT_TTL_MS):
        """Proposes a purchase against a signed quote and returns the kernel's decision.

        The amount and basket come from the quote, never from the caller: the kernel checks
        that they match and refuses with INT-003 if they do not.
        """
        quote = signed_quote.get("quote", signed_quote)
        expires = datetime.now(timezone.utc) + timedelta(milliseconds=intent_ttl_ms)
        intent = {
            "intent_id": f"int_{uuid.uuid4()}",
            "type": "purchase",
            "mandate_id": mandate_id,
            "quote_id": quote["quote_id"],
            "merchant_id": quote["merchant_id"],
            "amount_paise": quote["amount_paise"],
            "basket_hash": quote["basket_hash"],
            "rationale": rationale,
            "nonce": secrets.token_hex(16),
            "expires_at": expires.isoformat().replace("+00:00", "Z"),
        }
        return self.kit.request("POST", "/agent/acp/checkout", body={
            "signedIntent": {
                "intent": intent,
                "agent_id": self.agent_id,
                "signature": self.sign_intent(intent),
            },
            "signedQuote": signed_quote,
        })


class AgentKit:
    def __init__(self, base_url, api_key=None, fulfil_token=None, timeout=DEFAULT_TIMEOUT, opener=None):
        if not base_url:
            raise ValueError("base_url is required")
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.fulfil_token = fulfil_token
        self.timeout = timeout
        self._opener = opener or urllib.request.urlopen

    @staticmethod
    def generate_key_pair():
        return generate_key_pair()

    def request(self, method, path, body=None, door="agent", headers=None):
        """One HTTP call, with the refusal contract applied.

        Anything the kernel answers with a reason code is raised as AgentKitRefusal, so a
        denied purchase and a network failure are never confused for one another.
        """
        sent = {"Content-Type": "application/json"}
        if headers:
            sent.update(headers)
        if door == "agent" and self.api_key:
            sent["x-agentkit-key"] = self.api_key
        if door == "merchant":
            if not self.fulfil_token:
                raise ValueError("fulfil_token is required for the merchant door")
            sent["x-agentkit-token"] = self.fulfil_token

        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(f"{self.base_url}{path}", data=data, headers=sent, method=method)

        try:
            with self._opener(req, timeout=self.timeout) as response:
                status, text = response.status, response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            status, text = exc.code, exc.read().decode("utf-8")
        except Exception as exc:
            raise AgentKitError(f"request to {path} failed: {exc}") from exc

        try:
            parsed = json.loads(text) if text else None
        except ValueError:
            parsed = text

        reason = parsed.get("reason_code") if isinstance(parsed, dict) else None

        if status >= 400:
            message = (parsed.get("message") or parsed.get("error")) if isinstance(parsed, dict) else None
            message = message or f"{method} {path} returned {status}"
            if reason:
                raise AgentKitRefusal(reason, message, status=status, body=parsed)
            raise AgentKitError(message, status=status, body=parsed)

        return parsed

    # Identity

    def register_agent(self, name, public_key):
        """Registers a signing key and returns the agent id a mandate can be granted to.

        Registration is identity, never authority. Persist the keypair: generating a fresh
        one on each deploy orphans every mandate ever granted to the old id.
        """
        hexed = public_key.hex() if isinstance(public_key, (bytes, bytearray)) else public_key
        body = self.request("POST", "/agent/register", body={"name": name, "public_key": hexed})
        return body["agent_id"]

    def agent(self, agent_id, private_key) -> Agent:
        return Agent(self, agent_id, private_key)

    # Shopping

    def quote(self, mandate_id, items):
        return self.request("POST", "/agent/quote", body={"mandate_id": mandate_id, "items": items})

    def verify_quote(self, signed_quote, public_key) -> bool:
        quote = signed_quote.get("quote", signed_quote)
        return verify_payload(public_key, quote_signing_payload(quote), signed_quote["signature"])

    def search_catalog(self, mandate_id, query):
        """Search is mandate-scoped: each item comes back marked in_scope for that mandate."""
        return self.request("POST", "/agent/catalog/search", body={"mandate_id": mandate_id, "query": query})

    def catalog_item(self, sku):
        from urllib.parse import quote as urlquote

        return self.request("GET", f"/agent/catalog/{urlquote(str(sku))}")

    def mandate(self, mandate_id):
        return self.request("GET", f"/agent/mandate/{mandate_id}")

    def order_status(self, body):
        return self.request("POST", "/agent/orders/status", body=body)

    def order_history(self, body):
        return self.request("POST", "/agent/orders/history", body=body)

    def cancel_order(self, body):
        return self.request("POST", "/agent/orders/cancel", body=body)

    def reorder(self, body):
        return self.request("POST", "/agent/orders/reorder", body=body)

    def audit(self, intent_id):
        """The public record of one decision: what happened to this intent, in order, with
        the hash that fixes each entry in the chain. Needs no credential."""
        from urllib.parse import quote as urlquote

        return self.request("GET", f"/agent/audit/{urlquote(str(intent_id))}")

    def tools(self):
        return self.request("GET", "/agent/tools")

    def manifest(self):
        """The discovery document an agent reads to find this merchant's endpoints."""
        return self.request("GET", "/.well-known/agent-commerce.json")

    def health(self):
        return self.request("GET", "/health")

    # Consent

    def request_consent(self, agent_id, contact, requested_scope, limits,
                        customer_ref=None, fulfilment_ref=None):
        body = {
            "agent_id": agent_id,
            "contact": contact,
            "requested_scope": requested_scope,
            "limits": limits,
        }
        if customer_ref is not None:
            body["customer_ref"] = str(customer_ref)
        if fulfilment_ref is not None:
            body["fulfilment_ref"] = str(fulfilment_ref)
        return self.request("POST", "/consent/request", body=body)

    def consent_status(self, request_ref):
        return self.request("GET", f"/consent/{request_ref}/status")

    def bind_consent(self, request_ref, customer_ref, fulfilment_ref):
        """Binds a consent request to a real customer and address, in your own ids.

        Merchant door: needs fulfil_token. Only accepted before the grant exists, because
        afterwards the delivery target is fixed.
        """
        return self.request("POST", f"/consent/{request_ref}/bind", door="merchant",
                            body={"customer_ref": str(customer_ref),
                                  "fulfilment_ref": str(fulfilment_ref)})

    def authorization_token(self, request_ref, customer_ref, fulfilment_ref,
                            display_name=None, display_address=None, ttl_ms=DEFAULT_TOKEN_TTL_MS):
        """Your signed statement of who is approving and where the order goes.

        The display fields are the point. You cannot prove to the kernel that this customer
        id is this person, because it is your namespace and opaque to them. So the kernel
        shows the shopper the name and address you claim and lets them decline if it is not
        theirs.
        """
        if not self.fulfil_token:
            raise ValueError("fulfil_token is required to mint an authorization token")

        # Signed with the hash of the fulfil token, not the token itself. The kernel stores
        # only that hash, so it can verify without ever holding the token recoverably, and
        # every merchant ends up with a distinct signing key.
        secret = hashlib.sha256(self.fulfil_token.encode("utf-8")).hexdigest()

        # Compact separators, so identical claims produce byte-identical tokens in every
        # SDK. Python's json.dumps pads after separators by default and JSON.stringify
        # does not, which would otherwise make the same statement two different tokens.
        payload = _b64(json.dumps({
            "ref": request_ref,
            "customerRef": str(customer_ref),
            "fulfilmentRef": str(fulfilment_ref),
            "displayName": display_name,
            "displayAddress": display_address,
            "expiresAt": int(time.time() * 1000) + ttl_ms,
        }, separators=(",", ":")).encode("utf-8"))
        signature = _b64(hmac.new(
            secret.encode("ascii"), payload.encode("ascii"), hashlib.sha256,
        ).digest())
        return f"{payload}.{signature}"

    def consent_url(self, request_ref, token):
        from urllib.parse import quote as urlquote

        return f"{self.base_url}/consent/{urlquote(str(request_ref))}?auth={urlquote(str(token))}"
