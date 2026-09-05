"""The exact shapes the kernel signs over.

Field sets are closed. An extra key changes the bytes and invalidates the signature, and
a missing one does the same.
"""

from decimal import Decimal
from typing import Any, Mapping


def paise_to_canonical(value: Any) -> str:
    """Money is signed as a decimal string, never as a JSON number.

    Paise exceed float precision long before they exceed a realistic basket, and a float
    that rounds is a price that silently changed.
    """
    if isinstance(value, bool):
        raise TypeError("amount must be an integer, string or Decimal")
    if isinstance(value, int):
        return str(value)
    if isinstance(value, Decimal):
        if value != value.to_integral_value():
            raise TypeError(f"amount is not an integer: {value}")
        return str(int(value))
    if isinstance(value, str):
        stripped = value.lstrip("-")
        if not stripped.isdigit():
            raise TypeError(f"amount is not an integer: {value}")
        return str(int(value))
    raise TypeError(f"amount must be int, str or Decimal, received {type(value).__name__}")


def intent_signing_payload(intent: Mapping[str, Any]) -> dict:
    return {
        "amount_paise": paise_to_canonical(intent["amount_paise"]),
        "basket_hash": intent["basket_hash"],
        "expires_at": intent["expires_at"],
        "intent_id": intent["intent_id"],
        "mandate_id": intent["mandate_id"],
        "merchant_id": intent["merchant_id"],
        "nonce": intent["nonce"],
        "quote_id": intent["quote_id"],
        "rationale": intent["rationale"],
        "type": intent["type"],
    }


def quote_signing_payload(quote: Mapping[str, Any]) -> dict:
    return {
        "amount_paise": paise_to_canonical(quote["amount_paise"]),
        "basket_hash": quote["basket_hash"],
        "categories": sorted(quote["categories"]),
        "expires_at": quote["expires_at"],
        "issued_at": quote["issued_at"],
        "mandate_id": quote["mandate_id"],
        "merchant_id": quote["merchant_id"],
        "nonce": quote["nonce"],
        "quote_id": quote["quote_id"],
    }
