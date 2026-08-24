import type { OperatorRow } from "./operator.js";

function escape(v: string): string {
  return v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function rupees(paise: string): string {
  return `₹${(BigInt(paise) / 100n).toLocaleString("en-IN")}`;
}

/**
 * The operator console. One page: four tiles, one table, and the impersonate button.
 *
 * The button is the point of the page. Reading one merchant's detail requires
 * impersonating them, and impersonating writes a ledger entry to that merchant's own
 * operations chain — so the merchant sees, in their own console, every time the operator
 * looked. The party operating the guard layer cannot browse a merchant's ledger without
 * leaving a permanent, merchant-visible record.
 */
export function operatorPage(rows: OperatorRow[]): string {
  const merchants = rows.length;
  const decisions = rows.reduce((s, r) => s + r.decisionsTotal, 0);
  const denials = rows.reduce((s, r) => s + r.denialsTotal, 0);
  const healthy = rows.filter((r) => r.chainStatus === "ok").length;

  const table = rows.map((r) => {
    const rate = r.decisionsTotal === 0 ? "—" : `${Math.round((r.denialsTotal / r.decisionsTotal) * 100)}%`;
    const broken = r.chainStatus === "broken";
    return `<tr class="${broken ? "alert" : ""}">
      <td><code>${escape(r.merchantId)}</code></td>
      <td>${r.decisionsTotal}</td>
      <td>${rate}</td>
      <td>${rupees(r.gmvPaise)}</td>
      <td>${r.activeMandates}</td>
      <td>${rupees(r.reservationsHeld)}</td>
      <td class="${broken ? "bad" : "ok"}">${broken ? "BROKEN" : "ok"}</td>
      <td><form method="POST" action="/operator/impersonate">
        <input type="hidden" name="merchant_id" value="${escape(r.merchantId)}">
        <button type="submit">Impersonate</button></form></td>
    </tr>`;
  }).join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Operator</title>
<style>
  :root { color-scheme:light dark; --fg:#141414; --muted:#6b7280; --line:#e5e7eb;
          --bg:#fff; --panel:#fafafa; --ok:#047857; --bad:#b91c1c; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e8e8e8; --muted:#9ca3af;
    --line:#2a2a2a; --bg:#101010; --panel:#171717; --ok:#34d399; --bad:#f87171; } }
  *{box-sizing:border-box}
  body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
       margin:0;padding:28px;color:var(--fg);background:var(--bg)}
  .wrap{max-width:1000px;margin:0 auto}
  h1{font-size:19px;margin:0 0 4px} .sub{color:var(--muted);margin:0 0 18px}
  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:26px}
  .tile{border:1px solid var(--line);border-radius:10px;padding:14px;background:var(--panel)}
  .tile .n{font-size:26px;font-weight:700} .tile .l{color:var(--muted);font-size:12px}
  table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
  th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;
     color:var(--muted);padding:6px 10px;border-bottom:1px solid var(--line)}
  td{padding:8px 10px;border-bottom:1px solid var(--line)}
  tr.alert td{background:color-mix(in srgb, var(--bad) 12%, transparent)}
  .ok{color:var(--ok);font-weight:600} .bad{color:var(--bad);font-weight:700}
  code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
  button{font:inherit;font-size:12px;padding:5px 11px;border-radius:7px;
         border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer}
  .note{color:var(--muted);font-size:13px;margin-top:22px;max-width:60ch}
</style></head><body><div class="wrap">
<h1>Operator</h1>
<p class="sub">Fleet health. Aggregates only — no ledger row, no rule trace, no transaction detail.</p>
<div class="tiles">
  <div class="tile"><div class="n">${merchants}</div><div class="l">merchants live</div></div>
  <div class="tile"><div class="n">${decisions}</div><div class="l">decisions</div></div>
  <div class="tile"><div class="n">${decisions === 0 ? "—" : `${Math.round((denials / decisions) * 100)}%`}</div><div class="l">denial rate</div></div>
  <div class="tile"><div class="n">${healthy}/${merchants}</div><div class="l">chains healthy</div></div>
</div>
<table><thead><tr><th>merchant</th><th>decisions</th><th>denial rate</th><th>gmv</th>
  <th>mandates</th><th>held</th><th>chain</th><th></th></tr></thead>
<tbody>${table}</tbody></table>
<p class="note">This page cannot read a merchant's ledger. Doing so requires impersonation,
and impersonating writes an entry to that merchant's own operations chain — so they see,
in their own console, every time we looked.</p>
</div></body></html>`;
}
