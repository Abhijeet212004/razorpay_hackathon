const mongoose = require('mongoose');
const { AgentKit, AgentKitRefusal, AgentKitError } = require('@agentkit/merchant');

// The merchant's own in-app assistant.
//
// It is deliberately no more privileged than a third-party agent. It registers the same
// way, holds an Ed25519 keypair and no payment credential, and every purchase it proposes
// goes through the same mandate and the same policy gate. If it were trusted because it
// is ours, the whole argument would be decorative.
//
// Everything cryptographic here comes from @agentkit/merchant, the same package a
// third-party merchant installs. Nothing in this file is privileged shortcuts.

const kit = new AgentKit({
    baseUrl: process.env.KERNEL_URL || 'http://kernel:8080',
    apiKey: process.env.AGENTKIT_API_KEY || null,
    fulfilToken: process.env.AGENTKIT_FULFIL_TOKEN || '',
});

const ASSISTANT_NAME = 'Sharma Kirana Assistant';
const MERCHANT_ID = process.env.MERCHANT_ID || 'mch_sharma_kirana';

let identity = null;

/**
 * The assistant's identity, kept across restarts.
 *
 * A mandate is granted to an agent id. If the assistant generated a fresh keypair every
 * time this process started, every mandate a shopper had ever granted it would be
 * orphaned on the next deploy — refused with MND-001, with nothing on screen explaining
 * why. The key is the assistant's identity, not a cache.
 *
 * This is a signing key, never a payment credential: the worst an attacker with it can do
 * is propose purchases, which still have to pass the mandate and every policy rule.
 */
const identityModel = mongoose.models.AgentIdentity || mongoose.model(
    'AgentIdentity',
    new mongoose.Schema({
        name: { type: String, unique: true, required: true },
        agentId: { type: String, required: true },
        publicRaw: { type: String, required: true },
        privateRaw: { type: String, required: true },
        createdAt: { type: Date, default: Date.now },
    }),
);

/**
 * The kernel answers a refusal with a reason code and a transport failure with neither.
 * The SDK raises both; the routes in this app were written against a status and a body,
 * so unwrap back into that shape rather than rewriting them.
 */
async function called(fn) {
    try {
        return { status: 200, body: await fn() };
    } catch (error) {
        if (error instanceof AgentKitRefusal || error instanceof AgentKitError) {
            return { status: error.status ?? 502, body: error.body ?? { message: error.message } };
        }
        throw error;
    }
}

// Registration is identity, never authority. Until a user grants a mandate, every money
// call this agent makes is refused.
async function register() {
    if (identity) return identity;

    const saved = await identityModel.findOne({ name: ASSISTANT_NAME });
    if (saved) {
        identity = {
            agentId: saved.agentId,
            signer: kit.agent({ agentId: saved.agentId, privateKey: saved.privateRaw }),
        };
        return identity;
    }

    const keys = AgentKit.generateKeyPair();
    const { agentId } = await kit.registerAgent({
        name: ASSISTANT_NAME,
        publicKey: keys.publicKey,
    });

    await identityModel.create({
        name: ASSISTANT_NAME,
        agentId,
        publicRaw: keys.publicKey.toString('hex'),
        privateRaw: keys.privateKey.toString('hex'),
    });

    identity = { agentId, signer: kit.agent({ agentId, privateKey: keys.privateKey }) };
    console.log(`[agentkit] in-app assistant registered as ${agentId}`);
    return identity;
}

async function kernel(path, options = {}) {
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    return called(() => kit.request(method, path, { body }));
}

async function quote(mandateId, items) {
    return called(() => kit.quote({ mandateId, items }));
}

async function confirm(mandateId, signedQuote, rationale) {
    const me = await register();
    return called(() => me.signer.checkout({ mandateId, signedQuote, rationale }));
}

async function requestConsent(contact, customerRef, fulfilmentRef, agentId) {
    // Defaults to our own assistant, but any agent may be named. Ours is not privileged:
    // it registered the same way and passes the same gate.
    const id = agentId || (await register()).agentId;
    return called(() => kit.requestConsent({
        agentId: id,
        contact,
        // Who the shopper is and where their order goes, in the merchant's own ids. The
        // agent supplies neither and never learns either: it is told a mandate reference,
        // and the address is resolved here at fulfilment time.
        customerRef,
        fulfilmentRef,
        requestedScope: {
            merchants: [MERCHANT_ID],
            categories: ['groceries', 'household'],
            currency: 'INR',
        },
        limits: {
            per_transaction_paise: '500000',
            cumulative_paise: '1500000',
            silent_threshold_paise: '50000',
            velocity_per_hour: 3,
        },
    }));
}

/**
 * Our statement of who is approving, signed so the kernel can trust it came from us and
 * carried by the shopper's own browser so it cannot be applied to somebody else's
 * session.
 *
 * The display fields are the point of the exercise. We cannot prove to the kernel that
 * this customer id is this person — it is our namespace, opaque to them — so instead the
 * kernel shows the shopper the name and address we claim, and they decline if it is not
 * theirs. The one party who can check is asked to.
 */
function authorizationToken(requestRef, customerRef, fulfilmentRef, displayName, displayAddress) {
    return kit.authorizationToken({
        requestRef, customerRef, fulfilmentRef, displayName, displayAddress,
    });
}

module.exports = { register, quote, confirm, requestConsent, authorizationToken, kernel, kit };
