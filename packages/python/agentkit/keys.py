"""Ed25519 over canonical bytes.

Keys are handled as raw 32-byte values, the same way the kernel stores them, and wrapped
into whatever encoding the crypto library wants only at the moment it is needed.
"""

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

from .canonical import canonical_bytes

RAW_KEY_LENGTH = 32


def _raw(value, label: str) -> bytes:
    if isinstance(value, (bytes, bytearray)):
        return bytes(value)
    if isinstance(value, str):
        return bytes.fromhex(value)
    raise TypeError(f"{label} must be bytes or a hex string")


def generate_key_pair() -> tuple[bytes, bytes]:
    """Returns (public_key, private_key) as raw 32-byte values."""
    private = Ed25519PrivateKey.generate()
    from cryptography.hazmat.primitives import serialization

    return (
        private.public_key().public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        ),
        private.private_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PrivateFormat.Raw,
            encryption_algorithm=serialization.NoEncryption(),
        ),
    )


def sign_payload(private_key, payload) -> bytes:
    raw = _raw(private_key, "private key")
    if len(raw) != RAW_KEY_LENGTH:
        raise ValueError(f"ed25519 private key must be {RAW_KEY_LENGTH} bytes, received {len(raw)}")
    return Ed25519PrivateKey.from_private_bytes(raw).sign(canonical_bytes(payload))


def verify_payload(public_key, payload, signature) -> bool:
    try:
        raw = _raw(public_key, "public key")
        sig = _raw(signature, "signature")
        Ed25519PublicKey.from_public_bytes(raw).verify(sig, canonical_bytes(payload))
        return True
    except (InvalidSignature, ValueError, TypeError):
        return False
