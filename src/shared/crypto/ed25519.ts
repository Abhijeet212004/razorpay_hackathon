import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
} from "node:crypto";
import { canonicalBytes, type JsonValue } from "./jcs.js";

/**
 * Ed25519 over canonical bytes, via node:crypto. Keys are stored as raw 32-byte values
 * and wrapped into DER here, so what the database holds is the key rather than a
 * library's encoding of it.
 */

const RAW_PUBLIC_KEY_LENGTH = 32;
const RAW_PRIVATE_KEY_LENGTH = 32;

const DER_PUBLIC_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const DER_PRIVATE_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface RawKeyPair {
  publicKey: Buffer;
  privateKey: Buffer;
}

export function generateKeyPair(): RawKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });
  return {
    publicKey: Buffer.from(spki.subarray(spki.length - RAW_PUBLIC_KEY_LENGTH)),
    privateKey: Buffer.from(pkcs8.subarray(pkcs8.length - RAW_PRIVATE_KEY_LENGTH)),
  };
}

function toPublicKeyObject(raw: Buffer) {
  if (raw.length !== RAW_PUBLIC_KEY_LENGTH) {
    throw new Error(`ed25519 public key must be ${RAW_PUBLIC_KEY_LENGTH} bytes, received ${raw.length}`);
  }
  return createPublicKey({
    key: Buffer.concat([DER_PUBLIC_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

function toPrivateKeyObject(raw: Buffer) {
  if (raw.length !== RAW_PRIVATE_KEY_LENGTH) {
    throw new Error(`ed25519 private key must be ${RAW_PRIVATE_KEY_LENGTH} bytes, received ${raw.length}`);
  }
  return createPrivateKey({
    key: Buffer.concat([DER_PRIVATE_PREFIX, raw]),
    format: "der",
    type: "pkcs8",
  });
}

export function signBytes(privateKey: Buffer, message: Buffer): Buffer {
  return nodeSign(null, message, toPrivateKeyObject(privateKey));
}

export function verifyBytes(publicKey: Buffer, message: Buffer, signature: Buffer): boolean {
  try {
    return nodeVerify(null, message, toPublicKeyObject(publicKey), signature);
  } catch {
    return false;
  }
}

export function signPayload(privateKey: Buffer, payload: JsonValue): Buffer {
  return signBytes(privateKey, canonicalBytes(payload));
}

export function verifyPayload(publicKey: Buffer, payload: JsonValue, signature: Buffer): boolean {
  return verifyBytes(publicKey, canonicalBytes(payload), signature);
}
