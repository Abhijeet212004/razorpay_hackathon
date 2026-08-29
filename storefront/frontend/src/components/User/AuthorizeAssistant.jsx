import axios from 'axios';
import { useCallback, useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useSnackbar } from 'notistack';
import Loader from '../Layouts/Loader';
import MetaData from '../Layouts/MetaData';

// Where an assistant sends the shopper to authorise it.
//
// The assistant only ever had a reference. This page runs on the merchant's own origin,
// so it can see who is logged in — which the kernel cannot, and which is the whole reason
// this hop exists. The shopper picks where their orders may be delivered, and is then
// sent on to approve the limits.

const AuthorizeAssistant = () => {
    const navigate = useNavigate();
    const [params] = useSearchParams();
    const { enqueueSnackbar } = useSnackbar();
    const { isAuthenticated } = useSelector((state) => state.user);

    const ref = params.get('ref');
    const [loading, setLoading] = useState(true);
    const [addresses, setAddresses] = useState([]);
    const [chosen, setChosen] = useState('');
    const [shopper, setShopper] = useState('');
    const [sending, setSending] = useState(false);
    const [problem, setProblem] = useState('');

    const load = useCallback(async () => {
        try {
            const { data } = await axios.get(`/api/v1/agent/authorize?ref=${encodeURIComponent(ref)}`);
            setAddresses(data.addresses || []);
            setChosen(data.addresses?.[0]?.id || '');
            setShopper(data.shopper || '');
        } catch (error) {
            setProblem(error?.response?.data?.error || 'Could not load this request');
        } finally {
            setLoading(false);
        }
    }, [ref]);

    useEffect(() => {
        if (!ref) { setProblem('This link is missing its reference.'); setLoading(false); return; }
        if (isAuthenticated === false) {
            // Send them to log in, then straight back here.
            navigate(`/login?redirect=${encodeURIComponent(`/agent/authorize?ref=${ref}`)}`);
            return;
        }
        if (isAuthenticated) load();
    }, [ref, isAuthenticated, navigate, load]);

    const authorize = async () => {
        setSending(true);
        try {
            const { data } = await axios.post('/api/v1/agent/authorize', {
                ref,
                address_id: chosen,
            });
            // Off to the kernel, which serves the screen where the limits are approved.
            // We do not render that ourselves: a merchant able to draw its own consent
            // screen could mint its own grants.
            window.location.href = data.consent_url;
        } catch (error) {
            enqueueSnackbar(error?.response?.data?.error || 'Could not continue', { variant: 'error' });
            setSending(false);
        }
    };

    if (loading) return <Loader />;

    return (
        <>
            <MetaData title="Authorise an assistant" />
            <main className="w-full mt-20 flex justify-center px-4">
                <div className="w-full max-w-md bg-white shadow rounded-sm p-6 flex flex-col gap-5">
                    <div className="flex flex-col gap-1">
                        <h1 className="text-lg font-medium">Authorise an assistant</h1>
                        <p className="text-xs text-gray-500">
                            {shopper ? `Signed in as ${shopper}. ` : ''}
                            Choose where it may have orders delivered. It can use this address and
                            no other, and it never sees the address itself.
                        </p>
                    </div>

                    {problem ? (
                        <p className="text-sm text-red-600">{problem}</p>
                    ) : addresses.length === 0 ? (
                        <div className="flex flex-col gap-3">
                            <p className="text-sm text-gray-600">
                                You have no saved addresses. An assistant may only deliver to one you
                                have chosen yourself.
                            </p>
                            <button onClick={() => navigate('/account/addresses')}
                                className="bg-primary-blue text-white py-3 rounded-sm text-sm font-medium">
                                Add an address
                            </button>
                        </div>
                    ) : (
                        <>
                            <div className="flex flex-col gap-2">
                                {addresses.map((a) => (
                                    <label key={a.id}
                                        className={`flex gap-3 items-start border rounded-sm p-3 cursor-pointer ${
                                            chosen === a.id ? 'border-primary-blue bg-blue-50' : ''}`}>
                                        <input type="radio" name="address" value={a.id}
                                            checked={chosen === a.id}
                                            onChange={() => setChosen(a.id)} className="mt-1" />
                                        <span className="flex flex-col">
                                            <span className="text-xs text-gray-500">{a.label}</span>
                                            <span className="text-sm">{a.line}</span>
                                        </span>
                                    </label>
                                ))}
                            </div>

                            <button onClick={authorize} disabled={sending || !chosen}
                                className="bg-primary-orange text-white py-3 rounded-sm text-sm font-medium uppercase disabled:opacity-60">
                                {sending ? 'Continuing...' : 'Continue'}
                            </button>
                            <p className="text-xs text-gray-500">
                                Next you will see the spending limits and a code. Nothing is granted
                                until you enter it.
                            </p>
                        </>
                    )}
                </div>
            </main>
        </>
    );
};

export default AuthorizeAssistant;
