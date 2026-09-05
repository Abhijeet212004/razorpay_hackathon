import json
import sys
from decimal import Decimal
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agentkit import (
    AgentKit, AgentKitError, AgentKitRefusal,
    canonicalise, generate_key_pair, intent_signing_payload,
    paise_to_canonical, sign_payload, verify_payload,
)

INTENT = {
    "intent_id": "int_1", "type": "purchase", "mandate_id": "mnd_1", "quote_id": "qte_1",
    "merchant_id": "mch_1", "amount_paise": "42000", "basket_hash": "abc",
    "rationale": "weekly staples", "nonce": "ff00", "expires_at": "2030-01-01T00:00:00.000Z",
}


def test_canonicalisation_sorts_keys():
    assert canonicalise({"b": 2, "a": 1}) == '{"a":1,"b":2}'
    assert canonicalise({"z": [3, 1, 2]}) == '{"z":[3,1,2]}'
    assert canonicalise({"n": None, "t": True}) == '{"n":null,"t":true}'


def test_floats_are_refused_not_rounded():
    with pytest.raises(TypeError):
        canonicalise(1.5)
    with pytest.raises(TypeError):
        paise_to_canonical(1.5)


def test_money_is_a_decimal_string_whatever_the_caller_holds():
    assert paise_to_canonical(42000) == "42000"
    assert paise_to_canonical("42000") == "42000"
    assert paise_to_canonical(Decimal("42000")) == "42000"
    # Beyond float precision: must not silently round.
    assert paise_to_canonical(9007199254740993) == "9007199254740993"
    with pytest.raises(TypeError):
        paise_to_canonical("12.5")


def test_a_signed_intent_verifies_and_a_tampered_one_does_not():
    public, private = generate_key_pair()
    signature = sign_payload(private, intent_signing_payload(INTENT))

    assert verify_payload(public, intent_signing_payload(INTENT), signature)
    tampered = intent_signing_payload({**INTENT, "amount_paise": "1"})
    assert not verify_payload(public, tampered, signature)


def test_keys_survive_a_hex_round_trip():
    public, private = generate_key_pair()
    signature = sign_payload(private.hex(), {"a": 1})
    assert verify_payload(public.hex(), {"a": 1}, signature.hex())


class _Response:
    def __init__(self, status, text):
        self.status, self._text = status, text
    def read(self): return self._text.encode()
    def __enter__(self): return self
    def __exit__(self, *a): return False


def _kit_returning(status, payload, seen=None):
    def opener(req, timeout=None):
        if seen is not None:
            seen.append(dict(req.headers))
        return _Response(status, json.dumps(payload))
    return AgentKit(base_url="https://k.example", api_key="ak_public",
                    fulfil_token="ft_secret", opener=opener)


def test_the_fulfil_token_never_travels_through_the_agent_door():
    seen = []
    kit = _kit_returning(200, {}, seen)
    kit.quote("mnd_1", [])
    # urllib title-cases header names.
    lowered = {k.lower(): v for k, v in seen[0].items()}
    assert lowered["x-agentkit-key"] == "ak_public"
    assert "x-agentkit-token" not in lowered


def test_a_reason_code_is_a_refusal_not_a_transport_error():
    kit = _kit_returning(403, {"reason_code": "MND-001", "message": "no mandate"})
    with pytest.raises(AgentKitRefusal) as exc:
        kit.quote("mnd_x", [])
    assert exc.value.reason_code == "MND-001"


def test_a_transport_failure_is_not_mistaken_for_a_refusal():
    def opener(req, timeout=None):
        raise OSError("ECONNREFUSED")
    kit = AgentKit(base_url="https://k.example", opener=opener)
    with pytest.raises(AgentKitError) as exc:
        kit.health()
    assert not isinstance(exc.value, AgentKitRefusal)


def test_checkout_takes_amount_and_basket_from_the_quote():
    sent = {}
    def opener(req, timeout=None):
        sent.update(json.loads(req.data))
        return _Response(200, "{}")
    kit = AgentKit(base_url="https://k.example", opener=opener)
    public, private = generate_key_pair()
    agent = kit.agent("agt_1", private)
    agent.checkout("mnd_1", {"quote": {
        "quote_id": "qte_1", "merchant_id": "mch_1", "mandate_id": "mnd_1",
        "amount_paise": "42000", "basket_hash": "abc",
    }, "signature": "00"}, rationale="why")

    intent = sent["signedIntent"]["intent"]
    assert intent["amount_paise"] == "42000"
    assert intent["basket_hash"] == "abc"
    # The signature must cover what was actually sent.
    assert verify_payload(public, intent_signing_payload(intent), sent["signedIntent"]["signature"])


def test_an_authorization_token_is_ref_bound_and_tamper_evident():
    import base64
    kit = AgentKit(base_url="https://k.example", fulfil_token="ft_secret")
    token = kit.authorization_token("creq_1", "cus_1", "ful_1", "A Shopper", "12 Example Road")
    payload, signature = token.split(".")
    claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))

    assert claims["ref"] == "creq_1"
    assert claims["displayName"] == "A Shopper"

    other = AgentKit(base_url="https://k.example", fulfil_token="different")
    assert other.authorization_token(
        "creq_1", "cus_1", "ful_1", "A Shopper", "12 Example Road",
    ).split(".")[1] != signature


def test_a_missing_fulfil_token_is_refused_before_any_network_call():
    kit = AgentKit(base_url="https://k.example")
    with pytest.raises(ValueError):
        kit.authorization_token("creq_1", "c", "f")
