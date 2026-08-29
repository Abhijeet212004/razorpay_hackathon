import { useEffect, useState } from 'react';
import axios from 'axios';
import { useSnackbar } from 'notistack';
import MetaData from '../Layouts/MetaData';
import BackdropLoader from '../Layouts/BackdropLoader';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import CloseIcon from '@mui/icons-material/Close';

// Agent activity, inside the merchant's own admin.
//
// The Razorpay dashboard answers "did the money move". This answers "why was it allowed
// to". The join between them is the intent id in the order's notes field: copy it from
// there, paste it here, and land on the exact rule that decided.

const VERDICT = {
    ALLOW: 'text-primary-green bg-green-50 border-green-200',
    DENY: 'text-red-600 bg-red-50 border-red-200',
    STEP_UP: 'text-primary-yellow bg-yellow-50 border-yellow-200',
};

const rupees = (paise) =>
    paise == null ? '—' : `₹${(Number(paise) / 100).toLocaleString('en-IN')}`;

const ago = (iso) => {
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
};

const AgentActivity = () => {
    const { enqueueSnackbar } = useSnackbar();
    const [data, setData] = useState(null);
    const [trace, setTrace] = useState(null);
    const [lookup, setLookup] = useState('');

    const load = async () => {
        try {
            const { data: summary } = await axios.get('/api/v1/agent/console/summary');
            setData(summary);
        } catch {
            enqueueSnackbar('Could not reach the trust kernel', { variant: 'error' });
        }
    };

    useEffect(() => {
        load();
        const timer = setInterval(load, 10000);
        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const openTrace = async (intentId) => {
        if (!intentId) return;
        const { data: result } = await axios.get('/api/v1/agent/console/trace', {
            params: { intent_id: intentId },
        });
        setTrace(result);
    };

    if (!data) return <BackdropLoader />;

    const total = data.denials.reduce((sum, d) => sum + d.count, 0);
    const denied = data.denials
        .filter((d) => d.reasonCode !== 'OK-000')
        .reduce((sum, d) => sum + d.count, 0);
    const live = data.mandates.filter((m) => m.state === 'live').length;

    return (
        <>
            <MetaData title="Admin: Agent Activity" />
            {trace && <TracePanel trace={trace} onClose={() => setTrace(null)} />}

            <div className="flex flex-col gap-4 w-full">
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-lg font-medium">Agent activity</h1>
                        <p className="text-xs text-gray-500">
                            Why each purchase was allowed, or was not.
                        </p>
                    </div>
                    <span className={`text-xxs uppercase tracking-wide font-medium border rounded-full px-3 py-1 ${data.mode.rail === 'razorpay' ? 'text-red-600 border-red-300' : 'text-primary-yellow border-yellow-300'}`}>
                        {data.mode.rail === 'razorpay' ? 'live · razorpay test mode' : 'replay · recorded rail'}
                    </span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <Tile n={total} label="decisions" />
                    <Tile n={total ? `${Math.round((denied / total) * 100)}%` : '—'} label="denied" />
                    <Tile n={live} label="live mandates" />
                    <Tile n={data.denials.length} label="reason codes seen" />
                </div>

                <form
                    onSubmit={(e) => { e.preventDefault(); openTrace(lookup.trim()); }}
                    className="flex gap-2 bg-white p-3 shadow rounded-sm"
                >
                    <input
                        value={lookup}
                        onChange={(e) => setLookup(e.target.value)}
                        placeholder="Paste an intent_id from a Razorpay order's notes field"
                        className="flex-1 border rounded-sm px-3 py-2 text-sm outline-none focus:border-primary-blue"
                    />
                    <button type="submit" className="bg-primary-blue text-white text-sm font-medium px-5 rounded-sm">
                        Trace it
                    </button>
                </form>

                <Section title="Mandates">
                    <table className="w-full text-sm">
                        <thead>
                            <Head cols={['mandate', 'state', 'this window', '', 'silent below', 'chain']} />
                        </thead>
                        <tbody>
                            {data.mandates.map((m) => {
                                const pct = Math.min(
                                    100,
                                    Math.round((Number(m.spentPaise) / Math.max(1, Number(m.cumulativePaise))) * 100),
                                );
                                return (
                                    <tr key={m.mandateId} className="border-b hover:bg-gray-50">
                                        <td className="py-2 px-2 font-mono text-xs">{m.mandateId}</td>
                                        <td className="py-2 px-2">
                                            <span className={`text-xxs uppercase px-2 py-0.5 rounded-full border ${m.state === 'live' ? 'text-primary-green border-green-300' : 'text-gray-500 border-gray-300'}`}>
                                                {m.state}
                                            </span>
                                        </td>
                                        <td className="py-2 px-2">
                                            {rupees(m.spentPaise)}
                                            <span className="text-gray-400"> of {rupees(m.cumulativePaise)}</span>
                                        </td>
                                        <td className="py-2 px-2 w-40">
                                            <div className="h-1.5 w-full bg-gray-200 rounded-full overflow-hidden">
                                                <div
                                                    className={`h-full ${pct >= 95 ? 'bg-red-500' : pct >= 75 ? 'bg-primary-yellow' : 'bg-primary-green'}`}
                                                    style={{ width: `${pct}%` }}
                                                />
                                            </div>
                                            <span className="text-xxs text-gray-500">{pct}%</span>
                                        </td>
                                        <td className="py-2 px-2">{rupees(m.silentThresholdPaise)}</td>
                                        <td className="py-2 px-2 text-gray-500">{m.chainEntries}</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </Section>

                <Section title="Recent decisions">
                    <table className="w-full text-sm">
                        <thead>
                            <Head cols={['intent', 'verdict', 'reason', 'amount', 'when', '']} />
                        </thead>
                        <tbody>
                            {data.decisions.map((d) => (
                                <tr key={`${d.chainId}-${d.seq}`} className="border-b hover:bg-gray-50">
                                    <td className="py-2 px-2 font-mono text-xs">{d.intentId?.slice(0, 26)}</td>
                                    <td className="py-2 px-2">
                                        <span className={`text-xxs font-medium border rounded px-2 py-0.5 ${VERDICT[d.verdict] || 'text-gray-600 border-gray-300'}`}>
                                            {d.verdict}
                                        </span>
                                    </td>
                                    <td className="py-2 px-2 font-mono text-xs">{d.reasonCode}</td>
                                    <td className="py-2 px-2">{rupees(d.amountPaise)}</td>
                                    <td className="py-2 px-2 text-gray-500 text-xs">{ago(d.createdAt)}</td>
                                    <td className="py-2 px-2 text-right">
                                        <button
                                            onClick={() => openTrace(d.intentId)}
                                            className="text-primary-blue text-xs underline"
                                        >
                                            why?
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </Section>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <Section title="Reason codes seen">
                        <div className="flex flex-wrap gap-1.5">
                            {data.denials.map((d) => (
                                <span key={d.reasonCode} className="text-xxs font-mono border rounded px-2 py-1 bg-gray-50">
                                    {d.reasonCode} · {d.count}
                                </span>
                            ))}
                        </div>
                    </Section>

                    <Section title="Quarantined catalog items">
                        {data.quarantined.length === 0 ? (
                            <p className="text-xs text-gray-500">Nothing quarantined.</p>
                        ) : (
                            <div className="flex flex-col gap-2">
                                {data.quarantined.map((q) => (
                                    <div key={q.sku} className="flex gap-2 items-start text-xs bg-yellow-50 border border-yellow-200 rounded p-2">
                                        <WarningAmberIcon sx={{ fontSize: 16 }} className="text-primary-yellow shrink-0" />
                                        <div className="flex flex-col gap-0.5">
                                            <span className="font-medium">{q.name}</span>
                                            <span className="text-gray-600">
                                                Held out of the agent catalog. Still on sale to people.
                                            </span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </Section>
                </div>

                <p className="flex items-center gap-1.5 text-xxs text-gray-500 pb-4">
                    <ShieldOutlinedIcon sx={{ fontSize: 13 }} />
                    Read-only. This page connects as a database role that cannot write history.
                </p>
            </div>
        </>
    );
};

const Tile = ({ n, label }) => (
    <div className="bg-white shadow rounded-sm p-4 flex flex-col">
        <span className="text-2xl font-medium">{n}</span>
        <span className="text-xs text-gray-500">{label}</span>
    </div>
);

const Section = ({ title, children }) => (
    <div className="bg-white shadow rounded-sm p-4 flex flex-col gap-2 overflow-x-auto">
        <h2 className="text-xs uppercase tracking-wide text-gray-500 font-medium">{title}</h2>
        {children}
    </div>
);

const Head = ({ cols }) => (
    <tr className="border-b">
        {cols.map((c, i) => (
            <th key={i} className="text-left text-xxs uppercase tracking-wide text-gray-500 font-medium py-2 px-2">
                {c}
            </th>
        ))}
    </tr>
);

const TracePanel = ({ trace, onClose }) => (
    <div className="fixed inset-0 z-50 bg-black bg-opacity-40 flex justify-end" onClick={onClose}>
        <div
            className="bg-white w-full sm:w-[560px] h-full overflow-y-auto p-5 flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()}
        >
            <div className="flex items-start justify-between">
                <div>
                    <h2 className="font-medium">Audit trail</h2>
                    <p className="font-mono text-xxs text-gray-500 break-all">{trace.intentId}</p>
                </div>
                <button onClick={onClose}><CloseIcon sx={{ fontSize: 20 }} /></button>
            </div>

            <p className="text-xs text-gray-500">
                Every ledger entry for this purchase, in chain order. These are the same rows
                <code className="mx-1 bg-gray-100 px-1 rounded">agentkit verify</code>
                recomputes from scratch.
            </p>

            {trace.entries.length === 0 && (
                <p className="text-sm text-gray-500 mt-4">Nothing references that intent id.</p>
            )}

            {trace.entries.map((e) => (
                <div key={e.seq} className="border rounded-sm">
                    <div className="flex items-center justify-between bg-gray-50 px-3 py-1.5 border-b">
                        <span className="font-mono text-xs font-medium">
                            {e.seq} · {e.kind}
                        </span>
                        <span className="text-xxs text-gray-500">
                            {new Date(e.createdAt).toISOString().slice(11, 19)}
                        </span>
                    </div>
                    <pre className="text-xxs p-3 overflow-x-auto whitespace-pre-wrap break-all">
                        {JSON.stringify(e.payload, null, 2)}
                    </pre>
                </div>
            ))}
        </div>
    </div>
);

export default AgentActivity;
