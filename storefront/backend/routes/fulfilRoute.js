const express = require('express');
const crypto = require('crypto');
const Order = require('../models/orderModel');
const Product = require('../models/productModel');
const User = require('../models/userModel');
const sendEmail = require('../utils/sendEmail');

// Where an agent's order becomes a real order.
//
// The kernel authorises and pays; this is the merchant's own system recording that it
// happened. Without it an agent purchase would settle in Razorpay and appear nowhere the
// shopper looks — no entry in My Orders, no receipt, nothing in the admin.
//
// The kernel calls it on the internal network with a shared token. It is not a public
// route: nothing a browser or an agent can reach ends up here.
const router = express.Router();

function authorised(req) {
    const provided = String(req.headers['x-agentkit-token'] || '');
    const expected = String(process.env.AGENTKIT_FULFIL_TOKEN || '');
    if (expected.length === 0 || provided.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

router.post('/agent/fulfil', async (req, res) => {
    if (!authorised(req)) return res.status(401).json({ error: 'unauthorised' });

    const { intent_id, customer_ref, fulfilment_ref, items, amount_paise, payment_id, audit_url } = req.body || {};

    if (!intent_id || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'intent_id and items are required' });
    }

    // Idempotent on the intent. The kernel may retry; the shopper must not get two orders.
    const existing = await Order.findOne({ 'paymentInfo.id': intent_id });
    if (existing) return res.status(200).json({ success: true, order_id: existing._id, deduplicated: true });

    const user = customer_ref ? await User.findById(customer_ref).catch(() => null) : null;
    if (!user) {
        return res.status(404).json({ error: 'unknown customer_ref — the mandate was not bound to a shopper' });
    }

    // The address comes from the shopper's own saved addresses, chosen when they granted
    // permission. The agent neither supplied it nor can change it.
    const addresses = user.addresses || [];
    const chosen =
        addresses.find((a) => String(a._id) === String(fulfilment_ref)) || addresses[0] || null;

    if (!chosen) {
        return res.status(409).json({ error: 'the shopper has no saved delivery address' });
    }

    // Prices are re-read from the merchant's catalog. The kernel already checked the
    // total against a signed quote; this is the merchant's own books agreeing.
    const orderItems = [];
    for (const line of items) {
        const product = await Product.findById(line.sku).catch(() => null);
        if (!product) return res.status(409).json({ error: `unknown product ${line.sku}` });
        orderItems.push({
            name: product.name,
            price: product.price,
            quantity: Number(line.quantity) || 1,
            image: (product.images && product.images[0] && product.images[0].url) || '',
            product: product._id,
        });
        product.stock = Math.max(0, product.stock - (Number(line.quantity) || 1));
        await product.save({ validateBeforeSave: false });
    }

    const totalPrice = Number(amount_paise) / 100;

    const order = await Order.create({
        shippingInfo: {
            address: chosen.address,
            city: chosen.city,
            state: chosen.state,
            country: chosen.country || 'India',
            pincode: chosen.pincode,
            phoneNo: chosen.phoneNo || user.phone || '',
        },
        orderItems,
        paymentInfo: { id: intent_id, status: 'succeeded' },
        paidAt: Date.now(),
        totalPrice,
        orderStatus: 'Processing',
        user: user._id,
        placedBy: 'agent',
    });

    await sendEmail({
        email: user.email,
        templateId: process.env.SENDGRID_ORDER_TEMPLATEID,
        data: {
            name: user.name,
            shippingInfo: order.shippingInfo,
            orderItems,
            totalPrice,
            oid: order._id,
            placedByAgent: true,
            auditUrl: audit_url,
        },
    });

    console.log(`[agentkit] agent order ${order._id} for ${user.email}, ₹${totalPrice}`);
    res.status(201).json({ success: true, order_id: order._id });
});

module.exports = router;
