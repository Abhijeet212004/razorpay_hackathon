"""JSON Canonicalization Scheme (RFC 8785).

The kernel verifies every signature over exactly these bytes, so both sides must agree on
them down to key order and number formatting. A payload that differs by one byte produces
a valid signature over the wrong message, which the kernel reports as INT-001 and nothing
more. That is deliberate: a signature check that explained itself would be an oracle.
"""

import json
from decimal import Decimal
from typing import Any


def canonicalise(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, int):
        return str(value)
    if isinstance(value, Decimal):
        if value != value.to_integral_value():
            raise TypeError("only integral decimals may be canonicalised")
        return str(int(value))
    if isinstance(value, float):
        # Money never travels as a float. Refuse rather than sign a rounded value.
        raise TypeError("floats may not be canonicalised, use int or str")
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonicalise(v) for v in value) + "]"
    if isinstance(value, dict):
        items = sorted(value.items(), key=lambda kv: kv[0])
        return "{" + ",".join(
            f"{json.dumps(k, ensure_ascii=False, separators=(',', ':'))}:{canonicalise(v)}"
            for k, v in items
        ) + "}"
    raise TypeError(f"cannot canonicalise {type(value).__name__}")


def canonical_bytes(value: Any) -> bytes:
    return canonicalise(value).encode("utf-8")
