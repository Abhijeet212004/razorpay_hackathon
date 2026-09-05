"use strict";

const { randomUUID, randomBytes, createHmac, createHash } = require("node:crypto");

const { canonicalise, canonicalBytes } = require("./lib/canonical");
const { generateKeyPair, signPayload, verifyPayload } = require("./lib/keys");
const { intentSigningPayload, quoteSigningPayload, paiseToCanonical } = require("./lib/payloads");
const { AgentKitError, AgentKitRefusal } = require("./lib/errors");
const { createRoutes } = require("./lib/routes");
const { createVerify } = require("./lib/verify");

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_INTENT_TTL_MS = 120_000;
const DEFAULT_TOKEN_TTL_MS = 10 * 60_000;

function required(value, name) {
    if (value === undefined || value === null || value === "") {
        throw new TypeError(`${name} is required`);
    }
    return value;
}

/**
 * A registered agent that can sign intents.
 *
 * Returned by `kit.agent()`. Holds the private key in memory and nothing else: it has no
 * payment credential and no standing authority. Every purchase it proposes is checked
 * against the mandate at the moment of the call, so a stolen signing key buys nothing
 * that the mandate would not already have allowed.
 */
class Agent {
    constructor(kit, { agentId, privateKey }) {
        this.kit = kit;
        this.agentId = required(agentId, "agentId");
        this.privateKey = required(privateKey, "privateKey");
    }

    /** Signs an intent. Exposed for callers who want to transport it themselves. */
    signIntent(intent) {
        return signPayload(this.privateKey, intentSigningPayload(intent)).toString("hex");
    }

    /**
     * Proposes a purchase against a signed quote and returns the kernel's decision.
     *
     * The amount and basket come from the quote, never from the caller: the kernel checks
     * that they match and refuses with INT-003 if they do not. `rationale` is shown to the
     * shopper and recorded, but no rule reads it.
     */
    async checkout({ mandateId, signedQuote, rationale = "", intentTtlMs = DEFAULT_INTENT_TTL_MS }) {
        required(mandateId, "mandateId");
        required(signedQuote, "signedQuote");
        const quote = signedQuote.quote ?? signedQuote;

        const intent = {
            intent_id: `int_${randomUUID()}`,
            type: "purchase",
            mandate_id: mandateId,
            quote_id: quote.quote_id,
            merchant_id: quote.merchant_id,
            amount_paise: quote.amount_paise,
            basket_hash: quote.basket_hash,
            rationale,
            nonce: randomBytes(16).toString("hex"),
            expires_at: new Date(Date.now() + intentTtlMs).toISOString(),
        };

        return this.kit.request("POST", "/agent/acp/checkout", {
            body: {
                signedIntent: {
                    intent,
                    agent_id: this.agentId,
                    signature: this.signIntent(intent),
                },
                signedQuote,
            },
        });
    }
}

/**
 * A client for one merchant's AgentKit kernel.
 *
 * Two credentials, two doors, and they are not interchangeable. `apiKey` opens the agent
 * door, which is the surface a third-party agent is given. `fulfilToken` opens the
 * merchant door, which binds a consent request to a real customer and address, and is the
 * secret your own backend holds. Never ship the merchant token to an agent.
 */
class AgentKit {
    constructor({
        baseUrl,
        apiKey = null,
        fulfilToken = null,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        fetch: fetchImpl = globalThis.fetch,
    } = {}) {
        this.baseUrl = String(required(baseUrl, "baseUrl")).replace(/\/+$/, "");
        this.apiKey = apiKey;
        // Named for AGENTKIT_FULFIL_TOKEN, which is what it is called everywhere else.
        this.fulfilToken = fulfilToken;
        this.timeoutMs = timeoutMs;
        this.fetchImpl = fetchImpl;
    }

    static generateKeyPair() {
        return generateKeyPair();
    }

    /**
     * One HTTP call, with the refusal contract applied.
     *
     * Anything the kernel answers with a reason code is raised as AgentKitRefusal, so a
     * denied purchase and a network failure are never confused for one another. A refusal
     * is an answer; an AgentKitError is a broken pipe.
     */
    async request(method, path, { body = null, door = "agent", headers = {} } = {}) {
        const url = `${this.baseUrl}${path}`;
        const sent = { "content-type": "application/json", ...headers };

        if (door === "agent" && this.apiKey) sent["x-agentkit-key"] = this.apiKey;
        if (door === "merchant") {
            sent["x-agentkit-token"] = required(this.fulfilToken, "fulfilToken");
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        let response;
        try {
            response = await this.fetchImpl(url, {
                method,
                headers: sent,
                body: body === null ? undefined : JSON.stringify(body),
                signal: controller.signal,
            });
        } catch (cause) {
            const reason = cause?.name === "AbortError"
                ? `request to ${path} timed out after ${this.timeoutMs}ms`
                : `request to ${path} failed: ${cause?.message ?? cause}`;
            throw new AgentKitError(reason, { body: null });
        } finally {
            clearTimeout(timer);
        }

        const text = await response.text();
        let parsed;
        try {
            parsed = text === "" ? null : JSON.parse(text);
        } catch {
            parsed = text;
        }

        const reasonCode = parsed && typeof parsed === "object"
            ? parsed.reason_code ?? parsed.reasonCode ?? null
            : null;

        if (!response.ok) {
            const message = (parsed && typeof parsed === "object"
                && (parsed.message ?? parsed.error)) || `${method} ${path} returned ${response.status}`;
            throw reasonCode === null
                ? new AgentKitError(message, { status: response.status, body: parsed })
                : new AgentKitRefusal(reasonCode, message, { status: response.status, body: parsed });
        }

        return parsed;
    }

    // Identity ---------------------------------------------------------------

    /**
     * Registers a signing key and returns the agent id a mandate can be granted to.
     *
     * Registration is identity, never authority. Until a shopper grants a mandate, every
     * money call this agent makes is refused with MND-001. Persist the keypair: generating
     * a fresh one on each deploy orphans every mandate ever granted to the old id.
     */
    async registerAgent({ name, publicKey }) {
        required(name, "name");
        const hex = Buffer.isBuffer(publicKey) ? publicKey.toString("hex") : required(publicKey, "publicKey");
        const body = await this.request("POST", "/agent/register", {
            body: { name, public_key: hex },
        });
        return { agentId: body.agent_id, ...body };
    }

    /** Binds a stored keypair to this client so it can sign. Does no network call. */
    agent({ agentId, privateKey }) {
        return new Agent(this, { agentId, privateKey });
    }

    // Shopping ---------------------------------------------------------------

    /** A signed price for a basket, valid until it expires and bound to one mandate. */
    async quote({ mandateId, items }) {
        return this.request("POST", "/agent/quote", {
            body: { mandate_id: required(mandateId, "mandateId"), items: required(items, "items") },
        });
    }

    /** Verifies a quote signature locally, given the kernel's published quote key. */
    verifyQuote(signedQuote, publicKey) {
        const quote = signedQuote.quote ?? signedQuote;
        return verifyPayload(publicKey, quoteSigningPayload(quote), signedQuote.signature);
    }

    /** Search is mandate-scoped: each item comes back marked in_scope for that mandate. */
    searchCatalog({ mandateId, query }) {
        return this.request("POST", "/agent/catalog/search", {
            body: { mandate_id: required(mandateId, "mandateId"), query: required(query, "query") },
        });
    }

    catalogItem(sku) {
        return this.request("GET", `/agent/catalog/${encodeURIComponent(sku)}`);
    }

    mandate(mandateId) {
        return this.request("GET", `/agent/mandate/${encodeURIComponent(mandateId)}`);
    }

    orderStatus(body) {
        return this.request("POST", "/agent/orders/status", { body });
    }

    orderHistory(body) {
        return this.request("POST", "/agent/orders/history", { body });
    }

    cancelOrder(body) {
        return this.request("POST", "/agent/orders/cancel", { body });
    }

    reorder(body) {
        return this.request("POST", "/agent/orders/reorder", { body });
    }

    /**
     * The public record of one decision: what happened to this intent, in order, with the
     * hash that fixes each entry in the chain. Needs no credential, so the same call works
     * from a support tool or a shopper's own page.
     */
    audit(intentId) {
        return this.request("GET", `/agent/audit/${encodeURIComponent(String(intentId))}`);
    }

    /** The tool surface, in the shape an MCP or function-calling client expects. */
    tools() {
        return this.request("GET", "/agent/tools");
    }

    // Consent ----------------------------------------------------------------

    /**
     * Starts a consent request. Returns a reference and the URL to send the shopper to.
     *
     * The agent supplies neither the customer nor the address. It is told a mandate
     * reference and nothing else, and the address is resolved by your backend at
     * fulfilment time, so an agent never learns where its user lives.
     */
    async requestConsent({ agentId, contact, requestedScope, limits, customerRef, fulfilmentRef }) {
        return this.request("POST", "/consent/request", {
            body: {
                agent_id: required(agentId, "agentId"),
                contact: required(contact, "contact"),
                requested_scope: required(requestedScope, "requestedScope"),
                limits: required(limits, "limits"),
                ...(customerRef ? { customer_ref: String(customerRef) } : {}),
                ...(fulfilmentRef ? { fulfilment_ref: String(fulfilmentRef) } : {}),
            },
        });
    }

    consentStatus(requestRef) {
        return this.request("GET", `/consent/${encodeURIComponent(requestRef)}/status`);
    }

    /**
     * Binds a consent request to a real customer and address, in your own ids.
     *
     * Merchant door: needs fulfilToken. Only accepted before the grant exists, because
     * afterwards the delivery target is fixed. An agent cannot name an address, so a
     * compromised merchant must not be able to change one on the agent's behalf either.
     */
    bindConsent(requestRef, { customerRef, fulfilmentRef }) {
        return this.request("POST", `/consent/${encodeURIComponent(String(requestRef))}/bind`, {
            door: "merchant",
            body: {
                customer_ref: String(required(customerRef, "customerRef")),
                fulfilment_ref: String(required(fulfilmentRef, "fulfilmentRef")),
            },
        });
    }

    /**
     * Your signed statement of who is approving and where the order goes.
     *
     * The display fields are the point. You cannot prove to the kernel that this customer
     * id is this person, because it is your namespace and opaque to them. So the kernel
     * shows the shopper the name and address you claim and lets them decline if it is not
     * theirs. The one party who can check is the one asked to.
     *
     * Carried by the shopper's own browser, ref-bound and short-lived, so it cannot be
     * replayed into somebody else's session.
     */
    authorizationToken({ requestRef, customerRef, fulfilmentRef, displayName, displayAddress, ttlMs = DEFAULT_TOKEN_TTL_MS }) {
        /**
         * Signed with the hash of your fulfil token, not the token itself.
         *
         * The kernel stores only that hash, so it can verify without ever holding your
         * token in a recoverable form, and every merchant ends up with a distinct signing
         * key. Hashing here is what makes the two sides agree.
         */
        const secret = createHash("sha256")
            .update(required(this.fulfilToken, "fulfilToken"), "utf8")
            .digest("hex");
        const payload = Buffer.from(JSON.stringify({
            ref: required(requestRef, "requestRef"),
            customerRef: String(required(customerRef, "customerRef")),
            fulfilmentRef: String(required(fulfilmentRef, "fulfilmentRef")),
            displayName,
            displayAddress,
            expiresAt: Date.now() + ttlMs,
        }), "utf8").toString("base64url");
        const signature = createHmac("sha256", secret).update(payload).digest("base64url");
        return `${payload}.${signature}`;
    }

    /**
     * Middleware for the authorisation page and the consent handoff.
     *
     * You supply two functions so this can see your session and your addresses. It never
     * touches your database itself and holds no state.
     */
    routes(options) {
        return createRoutes(this, options);
    }

    /**
     * Middleware for your fulfilment route. Checks the shared secret, deduplicates a
     * retried intent through the `lookup` you supply, and puts a parsed order on
     * `req.agentOrder`.
     */
    verify(options) {
        return createVerify(this, options);
    }

    /** Where to send a shopper to approve a grant, with your signed handoff attached. */
    consentUrl(requestRef, token) {
        return `${this.baseUrl}/consent/${encodeURIComponent(String(requestRef))}`
            + `?auth=${encodeURIComponent(String(token))}`;
    }

    /** The discovery document an agent reads to find this merchant's endpoints. */
    manifest() {
        return this.request("GET", "/.well-known/agent-commerce.json");
    }

    health() {
        return this.request("GET", "/health");
    }
}

module.exports = {
    AgentKit,
    Agent,
    AgentKitError,
    AgentKitRefusal,
    generateKeyPair,
    signPayload,
    verifyPayload,
    canonicalise,
    canonicalBytes,
    intentSigningPayload,
    quoteSigningPayload,
    paiseToCanonical,
};
