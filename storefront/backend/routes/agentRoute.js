const express = require('express');
const agentkit = require('../agentkit/agent');
const User = require('../models/userModel');
const { isAuthenticatedUser } = require('../middlewares/auth');

// guard.mount(app, "/agent")
//
// This is the whole integration. The merchant's existing routes are untouched; these are
// added beside them. Nothing here can move money — it can only ask the kernel to, and the
// kernel will refuse unless a mandate says otherwise.
const router = express.Router();

// Starts a grant. Returns a reference and a URL — never a mandate.
//
// Only a logged-in shopper may start one, and it is bound to one of their own saved
// addresses. An agent cannot reach this route, cannot choose whose account it acts on,
// and cannot name a delivery address that the shopper has not already saved.
router.post('/agent/consent', isAuthenticatedUser, async (req, res) => {
    const { contact, address_id, agent_id } = req.body || {};
    if (!/^\+?[0-9]{10,15}$/.test(contact || '')) {
        return res.status(400).json({ error: 'a phone number is required' });
    }

    const user = await User.findById(req.user.id).select('addresses');
    const addresses = user.addresses || [];
    if (addresses.length === 0) {
        return res.status(409).json({
            error: 'save a delivery address first — an agent may only deliver to one you chose',
        });
    }

    const chosen = address_id
        ? addresses.find((a) => String(a._id) === String(address_id))
        : addresses[0];
    if (!chosen) {
        return res.status(400).json({ error: 'that address is not one of yours' });
    }

    // An agent id may be supplied so a shopper can grant permission to an assistant that
    // is not ours — Claude, say. They still approve on the kernel's page, and the grant
    // is still bound to this account and this address.
    const result = await agentkit.requestConsent(contact, req.user.id, chosen._id, agent_id);
    res.status(result.status).json(result.body);
});

// Asks the assistant to buy something for the logged-in shopper.
//
// The shopper says what they want; the assistant proposes it; the kernel decides. Note
// what this route does NOT take: a price, an address, or a payee. It takes a search term
// and a mandate, and everything that could move money is resolved by someone else.
router.post('/agent/buy', isAuthenticatedUser, async (req, res) => {
    const { mandate_id, query, quantity } = req.body || {};
    if (!mandate_id || !query) {
        return res.status(400).json({ error: 'mandate_id and query are required' });
    }

    const found = await agentkit.kernel('/agent/catalog/search', {
        method: 'POST',
        body: JSON.stringify({ mandate_id, query }),
    });
    if (found.status !== 200) return res.status(found.status).json(found.body);

    const item = (found.body.items || []).find((i) => i.in_scope);
    if (!item) {
        return res.status(404).json({ error: 'nothing matching that is inside your limits' });
    }

    const quoted = await agentkit.quote(mandate_id, [
        { sku: item.sku, quantity: Math.max(1, parseInt(quantity, 10) || 1) },
    ]);
    if (quoted.status !== 200) return res.status(quoted.status).json(quoted.body);

    const decision = await agentkit.confirm(mandate_id, quoted.body, `restocking ${query}`);
    res.status(decision.status).json({
        item: { name: item.name, price_paise: item.price_paise },
        ...decision.body,
    });
});

// Where an assistant sends the shopper to authorise it.
//
// The assistant only ever has a reference. Landing here puts the shopper on an origin
// that can read their session, which is the whole point: the kernel serves the consent
// screen and cannot see who is approving. We identify them, they choose an address, and
// only then are they sent on to enter the code.
//
// GET renders. POST commits. Binding on a GET would make it reachable by a link, an
// image tag, or a browser prefetch.
router.get('/agent/authorize', isAuthenticatedUser, async (req, res) => {
    const { ref } = req.query || {};
    if (!ref) return res.status(400).json({ error: 'ref is required' });

    const user = await User.findById(req.user.id).select('addresses name');
    const addresses = user.addresses || [];
    if (addresses.length === 0) {
        return res.status(409).json({
            error: 'save a delivery address first — an assistant may only deliver to one you chose',
        });
    }

    res.status(200).json({
        request_ref: String(ref),
        shopper: user.name,
        addresses: addresses.map((a) => ({
            id: a._id,
            label: a.label,
            line: `${a.address}, ${a.city}, ${a.state} - ${a.pincode}`,
        })),
    });
});

router.post('/agent/authorize', isAuthenticatedUser, async (req, res) => {
    const { ref, address_id } = req.body || {};
    if (!ref) return res.status(400).json({ error: 'ref is required' });

    const user = await User.findById(req.user.id).select('addresses');
    const addresses = user.addresses || [];
    // Their own address or none: an id from the request body is checked against the
    // shopper's own list rather than trusted.
    const chosen = address_id
        ? addresses.find((a) => String(a._id) === String(address_id))
        : addresses[0];
    if (!chosen) return res.status(400).json({ error: 'that address is not one of yours' });

    // customer_ref comes from the session, never from the body. The address is rendered
    // on the consent screen so the shopper can see where their assistant will ship, and
    // refuse if it is not theirs.
    const token = agentkit.authorizationToken(
        ref,
        req.user.id,
        chosen._id,
        req.user.name,
        `${chosen.address}, ${chosen.city}, ${chosen.state} - ${chosen.pincode}`,
    );

    // Built here from configuration — never echoed from a query parameter, which would
    // turn this route into an open redirect.
    const base = process.env.PUBLIC_KERNEL_URL || 'http://localhost:58080';
    res.status(200).json({
        consent_url: `${base}/consent/${encodeURIComponent(ref)}?auth=${encodeURIComponent(token)}`,
    });
});

// Read-only pass-through so the admin can show agent activity without the browser
// needing to know the kernel exists.
router.get('/agent/console/:view', async (req, res) => {
    const query = new URLSearchParams(req.query).toString();
    const result = await agentkit.kernel(`/console/${req.params.view}${query ? `?${query}` : ''}`);
    res.status(result.status).json(result.body);
});

module.exports = router;
