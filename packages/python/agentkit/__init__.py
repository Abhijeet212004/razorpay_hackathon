from .canonical import canonical_bytes, canonicalise
from .client import Agent, AgentKit
from .errors import AgentKitError, AgentKitRefusal
from .keys import generate_key_pair, sign_payload, verify_payload
from .payloads import intent_signing_payload, paise_to_canonical, quote_signing_payload

__version__ = "1.0.0"
__all__ = [
    "AgentKit", "Agent", "AgentKitError", "AgentKitRefusal",
    "generate_key_pair", "sign_payload", "verify_payload",
    "canonicalise", "canonical_bytes",
    "intent_signing_payload", "quote_signing_payload", "paise_to_canonical",
]
