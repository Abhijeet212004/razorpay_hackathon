"use strict";

const { timingSafeEqual } = require("node:crypto");

/**
 * Middleware for the route where an agent's purchase becomes a real order in your system.
 *
 * The kernel authorises and pays; this is your own system recording that it happened.
 * Without it an agent purchase settles at the rail and appears nowhere the shopper looks:
 * no entry in their orders, no receipt, nothing in your admin.
 *
 * It is not a public route. The kernel calls it with a shared secret, and nothing a
 * browser or an agent can reach should end up here.
 */

/** Compared in constant time. A length check first, because timingSafeEqual throws on a mismatch. */
function tokenMatches(presented, expected) {
    if (typeof expected !== "string" || expected.length === 0) return false;
    if (typeof presented !== "string" || presented.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}

function send(res, status, body) {
    if (typeof res.status === "function" && typeof res.json === "function") {
        return res.status(status).json(body);
    }
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
}

function createVerify(kit, { lookup = null, present = null } = {}) {
    return async function agentkitVerify(req, res, next) {
        if (!tokenMatches(req.headers?.["x-agentkit-token"], kit.fulfilToken)) {
            return send(res, 401, { error: "unauthorised" });
        }

        const body = req.body ?? {};
        const {
            intent_id: intentId,
            customer_ref: customerRef,
            fulfilment_ref: fulfilmentRef,
            items,
            amount_paise: amountPaise,
            payment_id: paymentId,
            audit_url: auditUrl,
        } = body;

        if (!intentId || !Array.isArray(items) || items.length === 0) {
            return send(res, 400, { error: "intent_id and items are required" });
        }

        /**
         * Idempotent on the intent. The kernel may retry, and the shopper must not get two
         * orders. This can only deduplicate what it can see, so it asks your `lookup`. With
         * no lookup supplied the request is let through, which is a choice you are making.
         */
        if (typeof lookup === "function") {
            const existing = await lookup(intentId);
            if (existing) {
                const payload = typeof present === "function"
                    ? await present(existing)
                    : { order_id: existing.id ?? existing._id ?? null, deduplicated: true };
                return send(res, 200, payload);
            }
        }

        // Amounts stay decimal strings. Converting here would put a float in every handler.
        req.agentOrder = {
            intentId,
            customerRef: customerRef ?? null,
            fulfilmentRef: fulfilmentRef ?? null,
            items,
            amountPaise: amountPaise === undefined ? null : String(amountPaise),
            paymentId: paymentId ?? null,
            auditUrl: auditUrl ?? null,
        };

        return next();
    };
}

module.exports = { createVerify, tokenMatches };
