"use strict";

const {
    createPrivateKey,
    createPublicKey,
    generateKeyPairSync,
    sign: nodeSign,
    verify: nodeVerify,
} = require("node:crypto");

const { canonicalBytes } = require("./canonical");

/**
 * Ed25519 over canonical bytes.
 *
 * Keys are handled as raw 32-byte values and wrapped into DER only at the moment
 * node:crypto needs them, so what you store is the key rather than some library's
 * encoding of it. The kernel stores them the same way; the two must match.
 */

const RAW_PUBLIC_KEY_LENGTH = 32;
const RAW_PRIVATE_KEY_LENGTH = 32;

const DER_PUBLIC_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const DER_PRIVATE_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function toBuffer(value, label) {
    if (Buffer.isBuffer(value)) return value;
    if (typeof value === "string") return Buffer.from(value, "hex");
    throw new TypeError(`${label} must be a Buffer or a hex string`);
}

/** A fresh agent identity. Persist both halves: the id a mandate names is derived from it. */
function generateKeyPair() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ type: "spki", format: "der" });
    const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });
    return {
        publicKey: Buffer.from(spki.subarray(spki.length - RAW_PUBLIC_KEY_LENGTH)),
        privateKey: Buffer.from(pkcs8.subarray(pkcs8.length - RAW_PRIVATE_KEY_LENGTH)),
    };
}

function toPrivateKeyObject(raw) {
    if (raw.length !== RAW_PRIVATE_KEY_LENGTH) {
        throw new RangeError(
            `ed25519 private key must be ${RAW_PRIVATE_KEY_LENGTH} bytes, received ${raw.length}`,
        );
    }
    return createPrivateKey({
        key: Buffer.concat([DER_PRIVATE_PREFIX, raw]),
        format: "der",
        type: "pkcs8",
    });
}

function toPublicKeyObject(raw) {
    if (raw.length !== RAW_PUBLIC_KEY_LENGTH) {
        throw new RangeError(
            `ed25519 public key must be ${RAW_PUBLIC_KEY_LENGTH} bytes, received ${raw.length}`,
        );
    }
    return createPublicKey({
        key: Buffer.concat([DER_PUBLIC_PREFIX, raw]),
        format: "der",
        type: "spki",
    });
}

function signPayload(privateKey, payload) {
    const key = toPrivateKeyObject(toBuffer(privateKey, "private key"));
    return nodeSign(null, canonicalBytes(payload), key);
}

function verifyPayload(publicKey, payload, signature) {
    try {
        const key = toPublicKeyObject(toBuffer(publicKey, "public key"));
        return nodeVerify(null, canonicalBytes(payload), key, toBuffer(signature, "signature"));
    } catch {
        return false;
    }
}

module.exports = { generateKeyPair, signPayload, verifyPayload };
