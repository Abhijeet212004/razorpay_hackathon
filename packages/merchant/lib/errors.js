"use strict";

/**
 * A refusal carried as an error.
 *
 * The kernel answers a denied purchase with a reason code rather than prose, so that the
 * same denial reads identically in the ledger, the dashboard and here. `reasonCode` is
 * the value to branch on; `message` is for humans and may change.
 */
class AgentKitError extends Error {
    constructor(message, { status = null, reasonCode = null, body = null } = {}) {
        super(message);
        this.name = "AgentKitError";
        this.status = status;
        this.reasonCode = reasonCode;
        this.body = body;
    }
}

/** The kernel refused to act. Carries the reason code, e.g. MND-001, CAP-001, SEC-002. */
class AgentKitRefusal extends AgentKitError {
    constructor(reasonCode, message, extra = {}) {
        super(message, { ...extra, reasonCode });
        this.name = "AgentKitRefusal";
    }
}

module.exports = { AgentKitError, AgentKitRefusal };
