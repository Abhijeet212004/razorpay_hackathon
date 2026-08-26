import { paiseToCanonical, type Paise } from "../../shared/money.js";
import type { ConsentRequestView } from "./consent.validation.js";

/**
 * The two human screens. Server-rendered, no framework, and every value comes from
 * server-held state: the amount from the signed quote, the merchant from the allowlist,
 * the scope from the consent request row.
 *
 * Nothing the agent supplied is rendered. That is the whole point of these pages — a
 * compromised agent must not be able to write the words the user reads while deciding.
 */

/** Everything rendered goes through this. An agent cannot inject markup it cannot reach. */
function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function rupees(paise: Paise): string {
  const whole = paise / 100n;
  return `₹${whole.toLocaleString("en-IN")}`;
}

const STYLE = `
  :root { color-scheme: light dark; --fg:#111; --muted:#666; --line:#e3e3e3; --accent:#0b5; --bg:#fff; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#eee; --muted:#999; --line:#333; --bg:#141414; }
  }
  * { box-sizing: border-box; }
  body { font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         margin:0; padding:24px; color:var(--fg); background:var(--bg);
         display:flex; justify-content:center; }
  main { width:100%; max-width:420px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:var(--muted); font-size:14px; margin:0 0 20px; }
  .card { border:1px solid var(--line); border-radius:12px; padding:18px; margin-bottom:16px; }
  .row { display:flex; justify-content:space-between; gap:12px; padding:7px 0;
         border-bottom:1px solid var(--line); font-size:15px; }
  .row:last-child { border-bottom:0; }
  .row .k { color:var(--muted); }
  .row .v { font-weight:600; text-align:right; }
  button { width:100%; font:inherit; font-weight:600; padding:13px; border-radius:10px;
           border:0; background:var(--accent); color:#fff; cursor:pointer; }
  button.ghost { background:transparent; color:var(--muted); border:1px solid var(--line); margin-top:8px; }
  input { width:100%; font:inherit; padding:12px; border-radius:10px; border:1px solid var(--line);
          background:transparent; color:var(--fg); letter-spacing:4px; text-align:center; margin-bottom:12px; }
  .note { color:var(--muted); font-size:13px; margin-top:14px; }
  .demo { border:1px dashed var(--accent); border-radius:10px; padding:10px;
          text-align:center; margin-bottom:12px; font-size:14px; }
  .demo code { font-size:22px; letter-spacing:6px; font-weight:700; }
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

export function consentPage(
  view: ConsentRequestView,
  demoCode?: string,
  returnTo?: string,
): string {
  const body = `
    <h1>Let ${escape(view.agentName)} shop for you?</h1>
    <p class="sub">at ${escape(view.merchantName)}</p>

    <div class="card">
      <div class="row"><span class="k">Can buy</span>
        <span class="v">${escape(view.categories.join(", "))}</span></div>
      <div class="row"><span class="k">Per order, at most</span>
        <span class="v">${rupees(view.perTransactionPaise)}</span></div>
      <div class="row"><span class="k">Per month, at most</span>
        <span class="v">${rupees(view.cumulativePaise)}</span></div>
      <div class="row"><span class="k">Asks you first, above</span>
        <span class="v">${rupees(view.silentThresholdPaise)}</span></div>
      <div class="row"><span class="k">Orders per hour</span>
        <span class="v">${view.velocityPerHour}</span></div>
    </div>

    ${demoCode === undefined ? "" : `<div class="demo">Demo number — your code is <code>${escape(demoCode)}</code></div>`}

    <form method="POST" action="/consent/${escape(view.requestRef)}/verify${
      returnTo === undefined ? "" : `?return=${encodeURIComponent(returnTo)}`
    }">
      <input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6"
             placeholder="000000" autocomplete="one-time-code" required>
      <button type="submit">Allow</button>
    </form>
    <form method="POST" action="/consent/${escape(view.requestRef)}/reject">
      <button class="ghost" type="submit">Not now</button>
    </form>

    <p class="note">We sent a code to ${escape(view.contactMasked)}.
    You can cancel this at any time, and it expires in 30 days on its own.</p>`;
  return page("Approve access", body);
}

export interface StepUpView {
  readonly challengeId: string;
  readonly merchantName: string;
  readonly amountPaise: Paise;
  readonly expiresAt: Date;
}

export function stepUpPage(view: StepUpView): string {
  const body = `
    <h1>Approve ${rupees(view.amountPaise)}?</h1>
    <p class="sub">at ${escape(view.merchantName)}</p>

    <div class="card">
      <div class="row"><span class="k">Amount</span>
        <span class="v">${rupees(view.amountPaise)}</span></div>
      <div class="row"><span class="k">Merchant</span>
        <span class="v">${escape(view.merchantName)}</span></div>
      <div class="row"><span class="k">Expires</span>
        <span class="v">${escape(view.expiresAt.toISOString().slice(11, 16))} UTC</span></div>
    </div>

    <form method="POST" action="/agent/approve/${escape(view.challengeId)}">
      <button type="submit">Approve</button>
    </form>
    <form method="POST" action="/agent/approve/${escape(view.challengeId)}/reject">
      <button class="ghost" type="submit">Decline</button>
    </form>

    <p class="note">This amount is above the limit you set for silent purchases.
    Every figure here comes from the merchant's own price, not from the assistant.</p>`;
  return page("Approve purchase", body);
}

export function resultPage(
  title: string,
  message: string,
  detail?: string,
  returnTo?: string,
): string {
  return page(
    title,
    `<h1>${escape(title)}</h1><p class="sub">${escape(message)}</p>
     ${detail === undefined ? "" : `<div class="card"><div class="row"><span class="k">Reference</span><span class="v">${escape(detail)}</span></div></div>`}
     ${returnTo === undefined ? "" : `<form method="GET" action="${escape(returnTo)}">
       ${detail === undefined ? "" : `<input type="hidden" name="mandate" value="${escape(detail)}">`}
       <button type="submit">Back to the shop</button></form>`}`,
  );
}

export { paiseToCanonical };
