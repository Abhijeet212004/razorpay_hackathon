import type { DecisionRow, MandateRow, TraceEntry } from "./console.repository.js";

/**
 * The merchant console. The Razorpay dashboard answers "did the money move"; this answers
 * "why was it allowed to". The join between them is the intent id in the order's notes:
 * paste it into the search box and land on the exact rule evaluation.
 *
 * Server-rendered, one build, deployed three ways — the merchant runs it themselves in
 * shapes A and B, and it is the same page in shape C. Nothing is sent anywhere.
 */

function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function rupees(paise: string | null): string {
  if (paise === null) return "—";
  const whole = BigInt(paise) / 100n;
  const part = BigInt(paise) % 100n;
  return `₹${whole.toLocaleString("en-IN")}.${String(part).padStart(2, "0")}`;
}

function ago(at: Date): string {
  const mins = Math.round((Date.now() - at.getTime()) / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const STYLE = `
  :root { color-scheme: light dark; --fg:#141414; --muted:#6b7280; --line:#e5e7eb;
          --bg:#fff; --panel:#fafafa; --ok:#047857; --deny:#b91c1c; --step:#b45309; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e8e8e8; --muted:#9ca3af; --line:#2a2a2a; --bg:#101010; --panel:#171717;
            --ok:#34d399; --deny:#f87171; --step:#fbbf24; }
  }
  * { box-sizing:border-box; }
  body { font:14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         margin:0; padding:28px; color:var(--fg); background:var(--bg); }
  .wrap { max-width:1080px; margin:0 auto; }
  header { display:flex; align-items:baseline; gap:14px; flex-wrap:wrap; margin-bottom:6px; }
  h1 { font-size:19px; margin:0; }
  h2 { font-size:14px; text-transform:uppercase; letter-spacing:.07em; color:var(--muted);
       margin:30px 0 10px; font-weight:600; }
  .badge { font-size:11px; font-weight:700; letter-spacing:.06em; padding:3px 9px;
           border-radius:999px; border:1px solid var(--line); text-transform:uppercase; }
  .badge.replay { color:var(--step); border-color:var(--step); }
  .badge.live { color:var(--deny); border-color:var(--deny); }
  .sub { color:var(--muted); margin:0 0 8px; }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; }
  .tile { border:1px solid var(--line); border-radius:10px; padding:14px; background:var(--panel); }
  .tile .n { font-size:24px; font-weight:700; }
  .tile .l { color:var(--muted); font-size:12px; }
  table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
  th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.06em;
       color:var(--muted); padding:6px 10px; border-bottom:1px solid var(--line); }
  td { padding:8px 10px; border-bottom:1px solid var(--line); }
  tr:hover td { background:var(--panel); }
  code { font:12px ui-monospace, SFMono-Regular, Menlo, monospace; }
  a { color:inherit; }
  .v-ALLOW { color:var(--ok); font-weight:700; }
  .v-DENY { color:var(--deny); font-weight:700; }
  .v-STEP_UP { color:var(--step); font-weight:700; }
  .meter { height:6px; border-radius:3px; background:var(--line); overflow:hidden; width:120px; }
  .meter i { display:block; height:100%; background:var(--ok); }
  .meter i.hot { background:var(--step); }
  .meter i.full { background:var(--deny); }
  form.search { margin:14px 0 0; display:flex; gap:8px; }
  input { font:inherit; padding:9px 12px; border:1px solid var(--line); border-radius:8px;
          background:transparent; color:var(--fg); flex:1; }
  pre { background:var(--panel); border:1px solid var(--line); border-radius:8px;
        padding:12px; overflow:auto; font-size:12px; margin:0; }
  .quar { color:var(--step); }
`;

function shell(title: string, mode: { rail: string; live: boolean }, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title><style>${STYLE}</style></head><body><div class="wrap">
<header><h1>${escape(title)}</h1>
<span class="badge ${mode.live ? "live" : "replay"}">${mode.live ? "live · razorpay test mode" : "replay · recorded rail"}</span>
</header>${body}</div></body></html>`;
}

export interface ConsoleView {
  mode: { rail: string; live: boolean };
  decisions: DecisionRow[];
  mandates: MandateRow[];
  denials: Array<{ reasonCode: string; count: number }>;
  quarantined: Array<{ sku: string; name: string }>;
}

export function consolePage(view: ConsoleView): string {
  const total = view.denials.reduce((sum, d) => sum + d.count, 0);
  const denied = view.denials.filter((d) => d.reasonCode !== "OK-000").reduce((s, d) => s + d.count, 0);

  const tiles = `
    <div class="tiles">
      <div class="tile"><div class="n">${total}</div><div class="l">decisions</div></div>
      <div class="tile"><div class="n">${total === 0 ? "—" : `${Math.round((denied / total) * 100)}%`}</div><div class="l">denied</div></div>
      <div class="tile"><div class="n">${view.mandates.filter((m) => m.state === "live").length}</div><div class="l">live mandates</div></div>
      <div class="tile"><div class="n">${view.denials.length}</div><div class="l">distinct reason codes</div></div>
    </div>
    <form class="search" method="GET" action="/audit">
      <input name="intent_id" placeholder="Paste an intent_id from the Razorpay order's notes field"
             value="" autocomplete="off">
      <button type="submit" style="font:inherit;padding:9px 16px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer">Trace it</button>
    </form>`;

  const mandateRows = view.mandates.map((m) => {
    const pct = Number((BigInt(m.spentPaise) * 100n) / (BigInt(m.cumulativePaise) || 1n));
    const cls = pct >= 95 ? "full" : pct >= 75 ? "hot" : "";
    return `<tr>
      <td><code>${escape(m.mandateId)}</code></td>
      <td>${escape(m.state)}</td>
      <td>${rupees(m.spentPaise)} <span style="color:var(--muted)">of ${rupees(m.cumulativePaise)}</span></td>
      <td><div class="meter"><i class="${cls}" style="width:${Math.min(pct, 100)}%"></i></div></td>
      <td>${pct}%</td>
      <td>${rupees(m.silentThresholdPaise)}</td>
      <td>${m.chainEntries}</td>
    </tr>`;
  }).join("");

  const decisionRows = view.decisions.map((d) => `<tr>
      <td><a href="/audit?intent_id=${encodeURIComponent(d.intentId)}"><code>${escape(d.intentId.slice(0, 22))}</code></a></td>
      <td class="v-${escape(d.verdict)}">${escape(d.verdict)}</td>
      <td><code>${escape(d.reasonCode)}</code></td>
      <td>${rupees(d.amountPaise)}</td>
      <td style="color:var(--muted)">${escape(ago(d.createdAt))}</td>
    </tr>`).join("");

  const denialRows = view.denials.map((d) =>
    `<tr><td><code>${escape(d.reasonCode)}</code></td><td>${d.count}</td></tr>`).join("");

  const quarantinedRows = view.quarantined.length === 0
    ? `<p class="sub">Nothing quarantined.</p>`
    : `<table><thead><tr><th>sku</th><th>why it is not sold to agents</th></tr></thead><tbody>${
        view.quarantined.map((q) => `<tr><td><code>${escape(q.sku)}</code></td>
        <td class="quar">${escape(q.name)}</td></tr>`).join("")
      }</tbody></table>
      <p class="sub">Instructions in a product description are never read by a rule. These
      are held out of the catalog anyway, and the merchant is told — the buyer is not.</p>`;

  return shell("Agent activity", view.mode, `
    <p class="sub">Why each purchase was allowed, or was not.</p>
    ${tiles}
    <h2>Mandates</h2>
    <table><thead><tr><th>mandate</th><th>state</th><th>this window</th><th></th><th></th>
      <th>silent below</th><th>chain</th></tr></thead><tbody>${mandateRows}</tbody></table>
    <h2>Recent decisions</h2>
    <table><thead><tr><th>intent</th><th>verdict</th><th>reason</th><th>amount</th><th>when</th>
      </tr></thead><tbody>${decisionRows}</tbody></table>
    <h2>Reason codes seen</h2>
    <table><thead><tr><th>code</th><th>count</th></tr></thead><tbody>${denialRows}</tbody></table>
    <h2>Quarantined catalog items</h2>
    ${quarantinedRows}`);
}

export function auditPage(
  mode: { rail: string; live: boolean },
  intentId: string,
  entries: TraceEntry[],
): string {
  if (entries.length === 0) {
    return shell("Audit trail", mode,
      `<p class="sub">No entry references <code>${escape(intentId)}</code>.</p>
       <p class="sub"><a href="/">Back</a></p>`);
  }

  const rows = entries.map((e) => `<tr>
      <td>${e.seq}</td>
      <td><code>${escape(e.kind)}</code></td>
      <td style="color:var(--muted)">${escape(e.createdAt.toISOString().replace("T", " ").slice(0, 19))}</td>
      <td><pre>${escape(JSON.stringify(e.payload, null, 2))}</pre></td>
    </tr>`).join("");

  return shell("Audit trail", mode, `
    <p class="sub">Every ledger entry for <code>${escape(intentId)}</code>, in chain order.
    This is the same row a reviewer can recompute with <code>agentkit verify</code>.</p>
    <table><thead><tr><th>seq</th><th>kind</th><th>at</th><th>payload</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p class="sub" style="margin-top:18px"><a href="/">Back</a></p>`);
}
