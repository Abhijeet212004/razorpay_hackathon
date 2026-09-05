"use strict";

/**
 * The exact shapes the kernel signs over.
 *
 * These mirror intentSigningPayload and quoteSigningPayload in the kernel. Field sets are
 * closed: an extra key changes the bytes and invalidates the signature, and a missing one
 * does the same. Do not add to them without changing the kernel in the same commit.
 */

/**
 * Amounts are signed as decimal strings, never as JSON numbers.
 *
 * Paise exceed Number.MAX_SAFE_INTEGER long before they exceed a realistic basket, and a
 * float that rounds is a float that silently changes a price. Accepting bigint, string
 * and number here means the caller can hold money however they like and still sign the
 * one representation the kernel expects.
 */
function paiseToCanonical(value) {
    if (typeof value === "bigint") return value.toString(10);
    if (typeof value === "string") {
        if (!/^-?\d+$/.test(value)) throw new TypeError(`amount is not an integer: ${value}`);
        return BigInt(value).toString(10);
    }
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value)) {
            throw new TypeError(`amount cannot be represented exactly: ${value}`);
        }
        return String(value);
    }
    throw new TypeError(`amount must be bigint, string or number, received ${typeof value}`);
}

function intentSigningPayload(intent) {
    return {
        amount_paise: paiseToCanonical(intent.amount_paise),
        basket_hash: intent.basket_hash,
        expires_at: intent.expires_at,
        intent_id: intent.intent_id,
        mandate_id: intent.mandate_id,
        merchant_id: intent.merchant_id,
        nonce: intent.nonce,
        quote_id: intent.quote_id,
        rationale: intent.rationale,
        type: intent.type,
    };
}

function quoteSigningPayload(quote) {
    return {
        amount_paise: paiseToCanonical(quote.amount_paise),
        basket_hash: quote.basket_hash,
        categories: [...quote.categories].sort(),
        expires_at: quote.expires_at,
        issued_at: quote.issued_at,
        mandate_id: quote.mandate_id,
        merchant_id: quote.merchant_id,
        nonce: quote.nonce,
        quote_id: quote.quote_id,
    };
}

module.exports = { paiseToCanonical, intentSigningPayload, quoteSigningPayload };
