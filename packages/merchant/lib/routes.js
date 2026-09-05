"use strict";

/**
 * The two routes every merchant has to host, so nobody has to get them right twice.
 *
 * An agent only ever holds a reference. Landing the shopper here puts them on an origin
 * that can read their session, which is the whole point: the kernel serves the consent
 * screen and cannot see who is approving. You identify them, they choose an address, and
 * only then are they sent on to enter the code.
 *
 * Four properties this must not lose, each of which is a real hole if dropped:
 *
 *   1. GET renders, POST commits. Binding on a GET makes it reachable by a link, an image
 *      tag or a browser prefetch.
 *   2. The customer reference comes from the session, never from the body. Otherwise an
 *      agent names whichever customer it likes.
 *   3. A submitted address id is checked against that shopper's own addresses rather than
 *      trusted, or an agent ships to an address it chose.
 *   4. The redirect target is built from configuration, never echoed from a query
 *      parameter, which would make this an open redirect.
 *
 * Returned as plain middleware so it drops into Express without this package depending on
 * it.
 */

function send(res, status, body) {
    if (typeof res.status === "function" && typeof res.json === "function") {
        return res.status(status).json(body);
    }
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
}

async function readBody(req) {
    if (req.body !== undefined && req.body !== null) return req.body;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (chunks.length === 0) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        return {};
    }
}

function createRoutes(kit, {
    session,
    addresses,
    kernelUrl,
    path = "/authorize",
} = {}) {
    if (typeof session !== "function") throw new TypeError("routes({ session }) must be a function");
    if (typeof addresses !== "function") throw new TypeError("routes({ addresses }) must be a function");

    const base = String(kernelUrl ?? kit.baseUrl).replace(/\/+$/, "");

    return async function agentkitRoutes(req, res, next) {
        const url = new URL(req.url, "http://placeholder");
        const matched = url.pathname === path || url.pathname === `${path}/`;
        if (!matched) return typeof next === "function" ? next() : send(res, 404, { error: "not found" });

        const who = await session(req);
        if (!who) return send(res, 401, { error: "sign in to authorise an assistant" });

        const list = (await addresses(who.id)) ?? [];

        if (req.method === "GET") {
            const ref = url.searchParams.get("ref");
            if (!ref) return send(res, 400, { error: "ref is required" });
            if (list.length === 0) {
                return send(res, 409, {
                    error: "save a delivery address first, an assistant may only deliver to one you chose",
                });
            }
            return send(res, 200, {
                request_ref: ref,
                shopper: who.name ?? null,
                addresses: list.map((a) => ({ id: String(a.id), label: a.label ?? null, line: a.line })),
            });
        }

        if (req.method === "POST") {
            const body = await readBody(req);
            const ref = body.ref;
            if (!ref) return send(res, 400, { error: "ref is required" });

            // Their own address or none.
            const chosen = body.address_id
                ? list.find((a) => String(a.id) === String(body.address_id))
                : list[0];
            if (!chosen) return send(res, 400, { error: "that address is not one of yours" });

            const token = kit.authorizationToken({
                requestRef: String(ref),
                customerRef: String(who.id),
                fulfilmentRef: String(chosen.id),
                displayName: who.name,
                displayAddress: chosen.line,
            });

            return send(res, 200, {
                consent_url: `${base}/consent/${encodeURIComponent(String(ref))}?auth=${encodeURIComponent(token)}`,
            });
        }

        return send(res, 405, { error: "method not allowed" });
    };
}

module.exports = { createRoutes };
