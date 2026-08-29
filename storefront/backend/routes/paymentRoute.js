const express = require('express');
const {
    processPayment,
    verifyPayment,
    getPaymentStatus,
    sendRazorpayApiKey,
} = require('../controllers/paymentController');
const { isAuthenticatedUser } = require('../middlewares/auth');

const router = express.Router();

router.route('/payment/process').post(isAuthenticatedUser, processPayment);
router.route('/payment/verify').post(isAuthenticatedUser, verifyPayment);
router.route('/razorpaykey').get(sendRazorpayApiKey);
router.route('/payment/status/:id').get(isAuthenticatedUser, getPaymentStatus);

module.exports = router;
