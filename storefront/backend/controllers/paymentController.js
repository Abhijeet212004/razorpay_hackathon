const crypto = require('crypto');
const asyncErrorHandler = require('../middlewares/asyncErrorHandler');
const Payment = require('../models/paymentModel');
const Order = require('../models/orderModel');
const Product = require('../models/productModel');
const sendEmail = require('../utils/sendEmail');
const ErrorHandler = require('../utils/errorHandler');

// The human lane.
//
// A person checking out uses Razorpay Standard Checkout and enters a PIN, exactly as
// before. The agent lane goes through the trust kernel instead. Both settle into the same
// Razorpay account — the difference is who authorised, not where the money went.

const RZP = 'https://api.razorpay.com/v1';

function auth() {
    const id = process.env.RAZORPAY_KEY_ID;
    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!id || !secret) return null;
    return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
}

exports.sendRazorpayApiKey = asyncErrorHandler(async (req, res, next) => {
    // Only the publishable key id reaches the browser. The secret never leaves the server.
    res.status(200).json({ razorpayKeyId: process.env.RAZORPAY_KEY_ID || null });
});

exports.processPayment = asyncErrorHandler(async (req, res, next) => {
    const { amount } = req.body;
    const header = auth();

    if (!header) {
        return next(new ErrorHandler('Razorpay keys are not configured on this server', 503));
    }

    const response = await fetch(`${RZP}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: header },
        body: JSON.stringify({
            amount: Math.round(Number(amount) * 100), // paise, integer, never a float
            currency: 'INR',
            receipt: `rcpt_${crypto.randomUUID().slice(0, 18)}`,
            notes: { lane: 'human_checkout' },
        }),
    });

    const order = await response.json();
    if (!response.ok) {
        return next(new ErrorHandler(order?.error?.description || 'Could not create order', 502));
    }

    res.status(200).json({
        success: true,
        order,
        razorpayKeyId: process.env.RAZORPAY_KEY_ID,
    });
});

// Razorpay signs the callback with the key secret. An unverified payment is not a payment.
//
// The signature proves the browser did not invent the result. It does not prove the
// payment is captured, or that it is for the amount we asked — so the payment is also
// read back from Razorpay before anything is recorded.
exports.verifyPayment = asyncErrorHandler(async (req, res, next) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    const expected = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest('hex');

    const provided = Buffer.from(String(razorpay_signature || ''), 'utf8');
    const computed = Buffer.from(expected, 'utf8');
    const verified =
        provided.length === computed.length && crypto.timingSafeEqual(provided, computed);

    if (!verified) {
        return next(new ErrorHandler('Payment signature did not verify', 400));
    }

    const header = auth();
    if (!header) {
        return next(new ErrorHandler('Razorpay keys are not configured on this server', 503));
    }

    const response = await fetch(`${RZP}/payments/${razorpay_payment_id}`, {
        headers: { Authorization: header },
    });
    const payment = await response.json();

    if (!response.ok) {
        return next(new ErrorHandler(payment?.error?.description || 'Could not read payment', 502));
    }
    if (!['captured', 'authorized'].includes(payment.status)) {
        return next(new ErrorHandler(`Payment is ${payment.status}, not captured`, 400));
    }
    if (payment.order_id !== razorpay_order_id) {
        return next(new ErrorHandler('Payment belongs to a different order', 400));
    }

    // Recording is idempotent: the same payment posted twice must not become two rows.
    const already = await Payment.findOne({ txnId: razorpay_payment_id });
    if (!already) {
        // Every field this schema requires, filled from what Razorpay actually returned.
        // The schema predates Razorpay, so several names are Paytm's.
        await Payment.create({
            resultInfo: {
                resultStatus: 'TXN_SUCCESS',
                resultCode: '01',
                resultMsg: 'Txn Success',
            },
            txnId: payment.id,
            bankTxnId: payment.acquirer_data?.bank_transaction_id || payment.id,
            orderId: razorpay_order_id,
            txnAmount: String(payment.amount / 100),
            txnType: 'SALE',
            gatewayName: 'RAZORPAY',
            bankName: payment.bank || payment.wallet || payment.method || 'RAZORPAY',
            mid: process.env.RAZORPAY_KEY_ID,
            paymentMode: payment.method || 'RAZORPAY',
            refundAmt: String(payment.amount_refunded ? payment.amount_refunded / 100 : 0),
            txnDate: new Date((payment.created_at || 0) * 1000).toISOString(),
        });
    }

    // The order is created here rather than by a second call from the browser. A closed
    // tab used to mean the money moved and no order existed.
    const existing = await Order.findOne({ 'paymentInfo.id': razorpay_payment_id });
    if (existing) {
        return res.status(200).json({
            success: true,
            reference: razorpay_payment_id,
            order: existing._id,
        });
    }

    // Prices come from the catalogue, never from the browser. The cart is a request; what
    // it costs is the merchant's to say.
    const requested = Array.isArray(req.body.orderItems) ? req.body.orderItems : [];
    const priced = [];
    for (const item of requested) {
        const product = await Product.findById(item.product);
        if (!product) {
            return next(new ErrorHandler(`Product ${item.product} no longer exists`, 400));
        }
        const quantity = Math.max(1, parseInt(item.quantity, 10) || 1);
        priced.push({
            name: product.name,
            price: product.price,
            quantity,
            image: product.images?.[0]?.url || item.image,
            product: product._id,
        });
    }

    if (priced.length === 0) {
        return next(new ErrorHandler('No items to order', 400));
    }

    const totalPrice = priced.reduce((sum, i) => sum + i.price * i.quantity, 0);

    // What was actually paid is what the order must be worth.
    if (Math.round(totalPrice * 100) !== payment.amount) {
        return next(
            new ErrorHandler(
                `Paid ₹${payment.amount / 100} but the basket prices to ₹${totalPrice}`,
                400,
            ),
        );
    }

    const order = await Order.create({
        shippingInfo: req.body.shippingInfo,
        orderItems: priced,
        paymentInfo: { id: razorpay_payment_id, status: 'succeeded' },
        totalPrice,
        paidAt: Date.now(),
        user: req.user._id,
    });

    await sendEmail({
        email: req.user.email,
        templateId: process.env.SENDGRID_ORDER_TEMPLATEID,
        data: {
            name: req.user.name,
            shippingInfo: order.shippingInfo,
            orderItems: priced,
            totalPrice,
            oid: order._id,
        },
    });

    res.status(200).json({ success: true, reference: razorpay_payment_id, order: order._id });
});

exports.getPaymentStatus = asyncErrorHandler(async (req, res, next) => {
    const payment = await Payment.findOne({ orderId: req.params.id });
    if (!payment) return next(new ErrorHandler('Payment Details Not Found', 404));
    res.status(200).json({ success: true, payment });
});
