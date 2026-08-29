import axios from 'axios';
import { useCallback, useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { useSnackbar } from 'notistack';
import TextField from '@mui/material/TextField';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import DeleteIcon from '@mui/icons-material/Delete';
import Sidebar from './Sidebar';
import Loader from '../Layouts/Loader';
import MinCategory from '../Layouts/MinCategory';
import MetaData from '../Layouts/MetaData';
import states from '../../utils/states';

// Saved delivery addresses.
//
// These are also what an agent may deliver to. It picks one at consent time and learns an
// id, never an address, and it can neither add one here nor redirect an order to a new
// one. Deleting the last address is what stops an agent ordering at all.

const Addresses = () => {
    const navigate = useNavigate();
    const { enqueueSnackbar } = useSnackbar();
    const { isAuthenticated } = useSelector((state) => state.user);

    const [addresses, setAddresses] = useState([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const [connecting, setConnecting] = useState(false);
    const [consentUrl, setConsentUrl] = useState('');
    const [agentId, setAgentId] = useState('');

    const [label, setLabel] = useState('Home');
    const [address, setAddress] = useState('');
    const [city, setCity] = useState('');
    const [state, setState] = useState('');
    const [pincode, setPincode] = useState('');
    const [phoneNo, setPhoneNo] = useState('');

    const load = useCallback(async () => {
        try {
            const { data } = await axios.get('/api/v1/addresses');
            setAddresses(data.addresses || []);
        } catch (error) {
            enqueueSnackbar(error?.response?.data?.message || 'Could not load addresses', {
                variant: 'error',
            });
        } finally {
            setLoading(false);
        }
    }, [enqueueSnackbar]);

    useEffect(() => {
        if (isAuthenticated === false) {
            navigate('/login');
            return;
        }
        load();
    }, [isAuthenticated, navigate, load]);

    const addAddress = async (e) => {
        e.preventDefault();

        if (!/^[1-9][0-9]{5}$/.test(String(pincode))) {
            enqueueSnackbar('Enter a 6 digit pincode', { variant: 'error' });
            return;
        }
        if (!/^[0-9]{10}$/.test(String(phoneNo))) {
            enqueueSnackbar('Enter a 10 digit phone number', { variant: 'error' });
            return;
        }
        if (!state) {
            enqueueSnackbar('Select a state', { variant: 'error' });
            return;
        }

        setSaving(true);
        try {
            const { data } = await axios.post('/api/v1/addresses', {
                label, address, city, state, pincode, phoneNo,
            });
            setAddresses(data.addresses || []);
            setAddress(''); setCity(''); setState(''); setPincode(''); setPhoneNo('');
            enqueueSnackbar('Address saved', { variant: 'success' });
        } catch (error) {
            enqueueSnackbar(error?.response?.data?.message || 'Could not save address', {
                variant: 'error',
            });
        } finally {
            setSaving(false);
        }
    };

    // Hands an assistant a link, never a permission. The shopper approves on a page the
    // assistant cannot open, and the grant is bound to this account and this address.
    const connectAssistant = async (addressId) => {
        setConnecting(true);
        try {
            const { data } = await axios.post('/api/v1/agent/consent', {
                contact: '8263811035',
                address_id: addressId,
                // Blank means our own in-app assistant. Paste an id to grant permission
                // to an outside one instead — it gets no more than ours does.
                ...(agentId.trim() ? { agent_id: agentId.trim() } : {}),
            });
            setConsentUrl(data.consent_url);
        } catch (error) {
            enqueueSnackbar(
                error?.response?.data?.error || error?.response?.data?.message || 'Could not start',
                { variant: 'error' },
            );
        } finally {
            setConnecting(false);
        }
    };

    const removeAddress = async (id) => {
        try {
            const { data } = await axios.delete(`/api/v1/address/${id}`);
            setAddresses(data.addresses || []);
            enqueueSnackbar('Address removed', { variant: 'success' });
        } catch (error) {
            enqueueSnackbar(error?.response?.data?.message || 'Could not remove address', {
                variant: 'error',
            });
        }
    };

    return (
        <>
            <MetaData title="Manage Addresses" />
            <MinCategory />
            <main className="w-full mt-12 sm:mt-0">
                <div className="flex gap-3.5 sm:w-11/12 sm:mt-4 m-auto mb-7">

                    <Sidebar activeTab={"addresses"} />

                    <div className="flex-1 overflow-hidden shadow bg-white">
                        <div className="flex flex-col gap-8 m-4 sm:mx-8 sm:my-6">

                            <div className="flex flex-col gap-1">
                                <span className="font-medium text-lg">Manage Addresses</span>
                                <p className="text-xs text-gray-500">
                                    An agent acting for you can deliver to one of these and to nothing
                                    else. It never sees the address itself, only which one you chose.
                                </p>
                            </div>

                            {loading ? <Loader /> : (
                                <div className="flex flex-col gap-3">
                                    {addresses.length === 0 && (
                                        <p className="text-sm text-gray-500">
                                            No saved addresses yet. An agent cannot place an order until
                                            there is at least one.
                                        </p>
                                    )}
                                    {addresses.map((a) => (
                                        <div key={a._id} className="flex justify-between items-start gap-4 border rounded-sm p-4">
                                            <div className="flex flex-col gap-1">
                                                <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-sm w-max">{a.label}</span>
                                                <p className="text-sm font-medium">{a.address}</p>
                                                <p className="text-sm text-gray-600">{a.city}, {a.state} - {a.pincode}</p>
                                                <p className="text-sm text-gray-600">{a.phoneNo}</p>
                                            </div>
                                            <div className="flex items-center gap-3">
                                                <button
                                                    onClick={() => connectAssistant(a._id)}
                                                    disabled={connecting}
                                                    className="text-xs font-medium text-primary-blue border border-primary-blue rounded-sm px-3 py-1.5 hover:bg-blue-50 disabled:opacity-50"
                                                >
                                                    {connecting ? 'Starting...' : 'Let an assistant shop here'}
                                                </button>
                                                <button
                                                    onClick={() => removeAddress(a._id)}
                                                    className="text-gray-400 hover:text-red-500"
                                                    title="Remove this address"
                                                >
                                                    <DeleteIcon />
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}

                            <div className="flex flex-col sm:flex-row gap-3 items-center border-t pt-5">
                                <TextField value={agentId} onChange={(e) => setAgentId(e.target.value)}
                                    label="Outside assistant id (optional)" placeholder="agt_…"
                                    variant="outlined" size="small" fullWidth />
                                <p className="text-xs text-gray-500 sm:w-2/3">
                                    Leave blank for our own assistant. Paste an id — Claude will tell
                                    you its own — to let an outside assistant shop here instead.
                                </p>
                            </div>

                            {consentUrl && (
                                <div className="border border-primary-blue rounded-sm p-4 bg-blue-50 flex flex-col gap-2">
                                    <span className="font-medium text-sm">Approve it here</span>
                                    <p className="text-xs text-gray-600">
                                        Open this yourself. The assistant cannot open it, and cannot see
                                        the code we send you.
                                    </p>
                                    <a href={consentUrl} target="_blank" rel="noreferrer"
                                       className="text-sm text-primary-blue break-all underline">
                                        {consentUrl}
                                    </a>
                                </div>
                            )}

                            <form onSubmit={addAddress} className="flex flex-col gap-4 border-t pt-6">
                                <span className="font-medium">Add a new address</span>

                                <div className="flex flex-col sm:flex-row gap-4">
                                    <TextField value={label} onChange={(e) => setLabel(e.target.value)}
                                        label="Label" variant="outlined" size="small" className="sm:w-1/4" />
                                    <TextField value={address} onChange={(e) => setAddress(e.target.value)}
                                        label="Address" variant="outlined" size="small" fullWidth required />
                                </div>

                                <div className="flex flex-col sm:flex-row gap-4">
                                    <TextField value={city} onChange={(e) => setCity(e.target.value)}
                                        label="City" variant="outlined" size="small" fullWidth required />
                                    <FormControl fullWidth size="small">
                                        <InputLabel id="addr-state">State</InputLabel>
                                        <Select labelId="addr-state" value={state} label="State"
                                            onChange={(e) => setState(e.target.value)} required>
                                            {states.map((item) => (
                                                <MenuItem key={item.code} value={item.code}>{item.name}</MenuItem>
                                            ))}
                                        </Select>
                                    </FormControl>
                                </div>

                                <div className="flex flex-col sm:flex-row gap-4">
                                    <TextField value={pincode} onChange={(e) => setPincode(e.target.value)}
                                        label="Pincode" variant="outlined" size="small" fullWidth required />
                                    <TextField value={phoneNo} onChange={(e) => setPhoneNo(e.target.value)}
                                        label="Phone No" variant="outlined" size="small" fullWidth required />
                                </div>

                                <button type="submit" disabled={saving}
                                    className="bg-primary-orange w-full sm:w-1/3 py-3 text-sm font-medium text-white shadow hover:shadow-lg rounded-sm uppercase disabled:opacity-60">
                                    {saving ? 'Saving...' : 'Save address'}
                                </button>
                            </form>

                        </div>
                    </div>
                </div>
            </main>
        </>
    );
};

export default Addresses;
