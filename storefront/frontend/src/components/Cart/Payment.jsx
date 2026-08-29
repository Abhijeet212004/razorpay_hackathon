import axios from 'axios';
import { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { useSnackbar } from 'notistack';
import PriceSidebar from './PriceSidebar';
import Stepper from './Stepper';
import MetaData from '../Layouts/MetaData';
import { clearErrors } from '../../actions/orderAction';
import { emptyCart } from '../../actions/cartAction';

// The human lane. A person pays with Razorpay Standard Checkout and enters their PIN,
// exactly as they did before any of this existed.
//
// The agent lane never comes through here — it goes to the trust kernel. Both settle into
// the same Razorpay account, which is the point: the difference is who authorised, not
// where the money went.

function loadCheckout() {
    return new Promise((resolve) => {
        if (window.Razorpay) return resolve(true);
        const script = document.createElement('script');
        script.src = 'https://checkout.razorpay.com/v1/checkout.js';
        script.onload = () => resolve(true);
        script.onerror = () => resolve(false);
        document.body.appendChild(script);
    });
}

const Payment = () => {
    const dispatch = useDispatch();
    const navigate = useNavigate();
    const { enqueueSnackbar } = useSnackbar();

    const [payDisable, setPayDisable] = useState(false);

    const { shippingInfo, cartItems } = useSelector((state) => state.cart);
    const { user } = useSelector((state) => state.user);
    const { error } = useSelector((state) => state.newOrder);

    const totalPrice = cartItems.reduce((sum, item) => sum + item.price * item.quantity, 0);

    // The order is only created after the money moves, so anything that would make the
    // order invalid has to stop the payment rather than follow it. Taking a payment for
    // an order that cannot be saved is the one outcome worth guarding against here.
    const missing = ['address', 'city', 'state', 'pincode', 'phoneNo']
        .filter((field) => !shippingInfo?.[field]);

    const submitHandler = async (e) => {
        e.preventDefault();

        if (missing.length > 0) {
            enqueueSnackbar(`Delivery address is incomplete: ${missing.join(', ')}`, {
                variant: 'error',
            });
            navigate('/shipping');
            return;
        }

        setPayDisable(true);

        try {
            const ready = await loadCheckout();
            if (!ready) throw new Error('Could not reach Razorpay Checkout');

            const config = { headers: { 'Content-Type': 'application/json' } };
            const { data } = await axios.post(
                '/api/v1/payment/process',
                { amount: Math.round(totalPrice) },
                config,
            );

            const checkout = new window.Razorpay({
                key: data.razorpayKeyId,
                amount: data.order.amount,
                currency: data.order.currency,
                name: 'Sharma Kirana',
                description: `${cartItems.length} item${cartItems.length === 1 ? '' : 's'}`,
                order_id: data.order.id,
                prefill: {
                    name: user?.name,
                    email: user?.email,
                    contact: shippingInfo?.phoneNo,
                },
                theme: { color: '#2874f0' },
                handler: async (response) => {
                    // Razorpay signs the result. An unverified payment is not a payment,
                    // so the server checks the signature before anything is recorded.
                    try {
                        // One call: the server confirms the payment with Razorpay, prices
                        // the basket from its own catalogue and creates the order. The
                        // browser is no longer what stands between paying and having an
                        // order.
                        await axios.post('/api/v1/payment/verify', {
                            ...response,
                            shippingInfo,
                            orderItems: cartItems.map((i) => ({
                                product: i.product,
                                quantity: i.quantity,
                            })),
                        }, config);

                        dispatch(emptyCart());
                        navigate('/orders/success');
                    } catch (verifyError) {
                        // The money has already moved by this point, so say what actually
                        // went wrong rather than implying the payment did not happen.
                        const reason = verifyError?.response?.data?.message || verifyError.message;
                        enqueueSnackbar(
                            `Payment ${response.razorpay_payment_id} went through, but we could not record it: ${reason}`,
                            { variant: 'error', autoHideDuration: 12000 },
                        );
                        setPayDisable(false);
                    }
                },
                modal: {
                    ondismiss: () => setPayDisable(false),
                },
            });

            checkout.on('payment.failed', (res) => {
                enqueueSnackbar(res.error?.description || 'Payment failed', { variant: 'error' });
                setPayDisable(false);
            });

            checkout.open();
        } catch (err) {
            setPayDisable(false);
            enqueueSnackbar(
                err?.response?.data?.message || err.message || 'Payment could not be started',
                { variant: 'error' },
            );
        }
    };

    useEffect(() => {
        if (error) {
            dispatch(clearErrors());
            enqueueSnackbar(error, { variant: 'error' });
        }
    }, [dispatch, error, enqueueSnackbar]);

    return (
        <>
            <MetaData title="Sharma Kirana: Secure Payment" />
            <main className="w-full mt-20">
                <div className="flex flex-col sm:flex-row gap-3.5 w-full sm:w-11/12 mt-0 sm:mt-4 m-auto sm:mb-7">
                    <div className="flex-1">
                        <Stepper activeStep={3}>
                            <div className="w-full bg-white">
                                <form onSubmit={submitHandler} className="flex flex-col justify-start gap-2 w-full mx-8 my-4 overflow-hidden">
                                    <div className="flex items-center gap-4 border rounded-sm p-3 w-full sm:w-3/5">
                                        <img
                                            draggable="false"
                                            className="h-6 w-6 object-contain"
                                            src="https://cdn.razorpay.com/logo.svg"
                                            alt="Razorpay"
                                            onError={(ev) => { ev.currentTarget.style.display = 'none'; }}
                                        />
                                        <div className="flex flex-col">
                                            <span className="font-medium">Pay with Razorpay</span>
                                            <span className="text-xs text-gray-500">UPI, cards, netbanking and wallets</span>
                                        </div>
                                    </div>

                                    <p className="text-xs text-gray-500 w-full sm:w-3/5 mt-1">
                                        You will be asked for your UPI PIN. This is the ordinary human
                                        checkout, unchanged.
                                    </p>

                                    <input
                                        type="submit"
                                        value={`Pay ₹${totalPrice.toLocaleString()}`}
                                        disabled={payDisable}
                                        className={`${payDisable ? 'bg-primary-grey cursor-not-allowed' : 'bg-primary-orange cursor-pointer'} w-full sm:w-3/5 my-2 py-3 font-medium text-white shadow hover:shadow-lg rounded-sm uppercase outline-none`}
                                    />
                                </form>
                            </div>
                        </Stepper>
                    </div>

                    <PriceSidebar cartItems={cartItems} />
                </div>
            </main>
        </>
    );
};

export default Payment;
