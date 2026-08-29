const crypto = require('crypto');
const mongoose = require('mongoose');
const { canonicalise } = require('./canonical');

// The merchant's own in-app assistant.
//
// It is deliberately no more privileged than a third-party agent. It registers the same
// way, holds an Ed25519 keypair and no payment credential, and every purchase it proposes
// goes through the same mandate and the same policy gate. If it were trusted because it
// is ours, the whole argument would be decorative.

const KERNEL = process.env.KERNEL_URL || 'http://kernel:8080';
const DER_PRIVATE_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

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

const ASSISTANT_NAME = 'Sharma Kirana Assistant';

function keypair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' });
    return {
        publicRaw: Buffer.from(spki.subarray(spki.length - 32)),
        privateRaw: Buffer.from(pkcs8.subarray(pkcs8.length - 32)),
    };
}

async function kernel(path, options = {}) {
    const res = await fetch(`${KERNEL}${path}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
}

// Registration is identity, never authority. Until a user grants a mandate, every money
// call this agent makes is refused.
async function register() {
    if (identity) return identity;

    const saved = await identityModel.findOne({ name: ASSISTANT_NAME });
    if (saved) {
        identity = {
            agentId: saved.agentId,
            publicRaw: Buffer.from(saved.publicRaw, 'hex'),
            privateRaw: Buffer.from(saved.privateRaw, 'hex'),
        };
        return identity;
    }

    const keys = keypair();
    const res = await kernel('/agent/register', {
        method: 'POST',
        body: JSON.stringify({ name: ASSISTANT_NAME, public_key: keys.publicRaw.toString('hex') }),
    });
    if (res.status !== 201) throw new Error(`register failed: ${res.status}`);

    await identityModel.create({
        name: ASSISTANT_NAME,
        agentId: res.body.agent_id,
        publicRaw: keys.publicRaw.toString('hex'),
        privateRaw: keys.privateRaw.toString('hex'),
    });

    identity = { agentId: res.body.agent_id, ...keys };
    console.log(`[agentkit] in-app assistant registered as ${identity.agentId}`);
    return identity;
}

function signIntent(privateRaw, intent) {
    const payload = {
        amount_paise: intent.amount_paise,
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
    const key = { key: Buffer.concat([DER_PRIVATE_PREFIX, privateRaw]), format: 'der', type: 'pkcs8' };
    return crypto.sign(null, Buffer.from(canonicalise(payload), 'utf8'), key).toString('hex');
}

async function quote(mandateId, items) {
    return kernel('/agent/quote', {
        method: 'POST',
        body: JSON.stringify({ mandate_id: mandateId, items }),
    });
}

async function confirm(mandateId, signedQuote, rationale) {
    const me = await register();
    const q = signedQuote.quote;
    const intent = {
        intent_id: `int_${crypto.randomUUID()}`,
        type: 'purchase',
        mandate_id: mandateId,
        quote_id: q.quote_id,
        merchant_id: q.merchant_id,
        amount_paise: q.amount_paise,
        basket_hash: q.basket_hash,
        // Display only. Nothing the assistant writes here can influence a rule.
        rationale,
        nonce: crypto.randomBytes(16).toString('hex'),
        expires_at: new Date(Date.now() + 120000).toISOString(),
    };
    return kernel('/agent/acp/checkout', {
        method: 'POST',
        body: JSON.stringify({
            signedIntent: { intent, agent_id: me.agentId, signature: signIntent(me.privateRaw, intent) },
            signedQuote,
        }),
    });
}

async function requestConsent(contact, customerRef, fulfilmentRef, agentId) {
    // Defaults to our own assistant, but any agent may be named. Ours is not privileged:
    // it registered the same way and passes the same gate.
    const me = agentId ? { agentId } : await register();
    return kernel('/consent/request', {
        method: 'POST',
        body: JSON.stringify({
            agent_id: me.agentId,
            contact,
            // Who the shopper is and where their order goes, in the merchant's own ids.
            // The agent supplies neither and never learns either: it is told a mandate
            // reference, and the address is resolved here at fulfilment time.
            ...(customerRef ? { customer_ref: String(customerRef) } : {}),
            ...(fulfilmentRef ? { fulfilment_ref: String(fulfilmentRef) } : {}),
            requested_scope: {
                merchants: [process.env.MERCHANT_ID || 'mch_sharma_kirana'],
                categories: ['groceries', 'household'],
                currency: 'INR',
            },
            limits: {
                per_transaction_paise: '500000',
                cumulative_paise: '1500000',
                silent_threshold_paise: '50000',
                velocity_per_hour: 3,
            },
        }),
    });
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
    const secret = process.env.AGENTKIT_FULFIL_TOKEN || '';
    const payload = Buffer.from(JSON.stringify({
        ref: requestRef,
        customerRef: String(customerRef),
        fulfilmentRef: String(fulfilmentRef),
        displayName,
        displayAddress,
        expiresAt: Date.now() + 10 * 60 * 1000,
    }), 'utf8').toString('base64url');
    const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
}

module.exports = { register, quote, confirm, requestConsent, authorizationToken, kernel };
