const express = require('express');
const User = require('../models/userModel');
const asyncErrorHandler = require('../middlewares/asyncErrorHandler');
const { isAuthenticatedUser } = require('../middlewares/auth');

// Saved delivery addresses.
//
// A person manages these while logged in. An agent never touches this route: it can only
// deliver to an address the shopper already chose, and it learns an id rather than an
// address.
const router = express.Router();

router.route('/addresses')
    .get(isAuthenticatedUser, asyncErrorHandler(async (req, res) => {
        const user = await User.findById(req.user.id).select('addresses');
        res.status(200).json({ success: true, addresses: user.addresses || [] });
    }))
    .post(isAuthenticatedUser, asyncErrorHandler(async (req, res) => {
        const { label, address, city, state, pincode, phoneNo, country } = req.body;
        if (!address || !city || !state || !pincode || !phoneNo) {
            return res.status(400).json({
                success: false,
                message: 'address, city, state, pincode and phoneNo are required',
            });
        }
        const user = await User.findById(req.user.id);
        user.addresses.push({ label: label || 'Home', address, city, state, pincode, phoneNo, country: country || 'India' });
        await user.save({ validateBeforeSave: false });
        res.status(201).json({ success: true, addresses: user.addresses });
    }));

router.route('/address/:id')
    .delete(isAuthenticatedUser, asyncErrorHandler(async (req, res) => {
        const user = await User.findById(req.user.id);
        const before = user.addresses.length;
        user.addresses = user.addresses.filter((a) => String(a._id) !== String(req.params.id));
        await user.save({ validateBeforeSave: false });
        res.status(200).json({
            success: true,
            removed: before - user.addresses.length,
            addresses: user.addresses,
        });
    }));

module.exports = router;
