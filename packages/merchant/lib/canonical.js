"use strict";

/**
 * JSON Canonicalization Scheme (RFC 8785).
 *
 * The kernel verifies every signature over exactly these bytes, so both sides must agree
 * on them down to key order and number formatting. This is the single most unforgiving
 * part of the integration: a payload that differs by one byte produces a valid signature
 * over the wrong message, which the kernel reports as INT-001 with no further detail.
 * That is deliberate — a signature check that explained itself would be an oracle.
 */
function canonicalise(value) {
    if (value === null) return "null";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") {
        // Money never travels as a number. Anything that cannot round-trip is a bug
        // upstream, so refuse rather than silently sign a rounded value.
        if (!Number.isSafeInteger(value)) {
            throw new TypeError("only safe integers may be canonicalised");
        }
        return String(value);
    }
    if (typeof value === "bigint") return value.toString(10);
    if (typeof value === "string") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalise).join(",")}]`;
    if (typeof value !== "object") {
        throw new TypeError(`cannot canonicalise ${typeof value}`);
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalise(value[k])}`).join(",")}}`;
}

function canonicalBytes(value) {
    return Buffer.from(canonicalise(value), "utf8");
}

module.exports = { canonicalise, canonicalBytes };
