import type { DecisionRow, MandateRow } from "../console/console.repository.js";
import type { MerchantRecord } from "../merchant/merchant.validation.js";
import { authShell, escape, shell, type ShellOptions } from "./dashboard.shell.js";

/** Paise are BIGINT strings all the way here, so they are formatted, never parsed to float. */
function rupees(paise: string | null): string {
  if (paise === null) return "\u2013";
  const negative = paise.startsWith("-");
  const digits = negative ? paise.slice(1) : paise;
  const whole = digits.length > 2 ? digits.slice(0, -2) : "0";
  return `${negative ? "-" : ""}₹${Number(whole).toLocaleString("en-IN")}`;
}

/** The merchant's own clock, not the container's. Servers run UTC; shopkeepers do not. */
const DISPLAY_TIME_ZONE = process.env.DISPLAY_TIME_ZONE ?? "Asia/Kolkata";

function when(date: Date): string {
  return date.toLocaleString("en-IN", {
    timeZone: DISPLAY_TIME_ZONE,
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

function verdict(value: string): string {
  const cls = value === "ALLOW" ? "allow" : value === "STEP_UP" ? "stepup" : "deny";
  const word = value === "ALLOW" ? "Approved" : value === "STEP_UP" ? "Asked a human" : "Refused";
  return `<span class="v ${cls}">${escape(word)}</span>`;
}

/* ------------------------------------------------------------------ auth */

export function signInPage(error?: string): string {
  return authShell("Sign in", `
    <div class="panel"><div class="body">
      ${error === undefined ? "" : `<div class="notice stop">${escape(error)}</div>`}
      <form method="POST" action="/dashboard/signin">
        <div class="field">
          <label for="email">Work email</label>
          <input id="email" name="email" type="email" required autocomplete="email">
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" required autocomplete="current-password">
        </div>
        <button class="btn" type="submit" style="width:100%">Sign in</button>
      </form>
    </div></div>
    <p class="alt">New here? <a href="/dashboard/signup">Create an account</a></p>`);
}

export function signUpPage(error?: string, values: Record<string, string> = {}): string {
  const v = (k: string) => escape(values[k] ?? "");
  return authShell("Create an account", `
    <div class="panel">
      <header><h2>Start accepting AI agents</h2></header>
      <div class="body">
        ${error === undefined ? "" : `<div class="notice stop">${escape(error)}</div>`}
        <form method="POST" action="/dashboard/signup">
          <div class="field">
            <label for="business">Business name</label>
            <input id="business" name="business" type="text" required value="${v("business")}">
          </div>
          <div class="field">
            <label for="email">Work email</label>
            <input id="email" name="email" type="email" required autocomplete="email" value="${v("email")}">
          </div>
          <div class="field">
            <label for="password">Password</label>
            <input id="password" name="password" type="password" required minlength="10"
                   autocomplete="new-password">
            <p class="hint">At least 10 characters.</p>
          </div>
          <div class="field">
            <label for="site">Your website</label>
            <input id="site" name="site" type="url" required placeholder="https://yourshop.com"
                   value="${v("site")}">
          </div>
          <div class="field">
            <label for="catalog">Product endpoint</label>
            <input id="catalog" name="catalog" type="url" required
                   placeholder="https://yourshop.com/api/products" value="${v("catalog")}">
            <p class="hint">The one you already have. We read it; we never write to it.</p>
          </div>
          <button class="btn" type="submit" style="width:100%">Create account</button>
        </form>
      </div>
    </div>
    <p class="alt">Already set up? <a href="/dashboard/signin">Sign in</a></p>`);
}

/* -------------------------------------------------------------- overview */

export interface OverviewData {
  readonly merchant: MerchantRecord;
  readonly decisions: readonly DecisionRow[];
  readonly mandates: readonly MandateRow[];
  readonly denials: ReadonlyArray<{ reasonCode: string; count: number }>;
  readonly quarantined: number;
}

export function overviewPage(opts: ShellOptions, data: OverviewData): string {
  const allowed = data.decisions.filter((d) => d.verdict === "ALLOW").length;
  const stepUp = data.decisions.filter((d) => d.verdict === "STEP_UP").length;
  const denied = data.decisions.filter((d) => d.verdict === "DENY").length;
  const live = data.mandates.filter((m) => m.state === "live").length;

  const configured = data.merchant.fulfilUrl !== null && data.merchant.authorizeUrl !== null;

  const rows = data.decisions.slice(0, 8).map((d) => `
    <tr>
      <td class="id"><a href="/dashboard/activity/${escape(d.intentId)}">${escape(d.intentId.slice(0, 22))}</a></td>
      <td>${verdict(d.verdict)} <span class="rc">${escape(d.reasonCode)}</span></td>
      <td class="num">${rupees(d.amountPaise)}</td>
      <td style="color:var(--ink-3);white-space:nowrap">${escape(when(d.createdAt))}</td>
    </tr>`).join("");

  return shell(opts, `
    <div class="head">
      <h1>Overview</h1>
      <p>Everything an AI agent has asked of ${escape(data.merchant.displayName)}, and what was decided.</p>
    </div>

    ${configured ? "" : `<div class="notice warn">
      <strong>Finish connecting your shop.</strong> Agents can browse your catalogue, but
      until a fulfilment endpoint is set an approved purchase cannot become an order in
      your system. <a href="/dashboard/integration">Set it up</a>.
    </div>`}

    <div class="stats">
      <div class="stat"><div class="k">Approved</div><div class="v">${allowed}</div>
        <div class="sub">agent purchases allowed</div></div>
      <div class="stat"><div class="k">Sent to a human</div><div class="v">${stepUp}</div>
        <div class="sub">above the silent limit</div></div>
      <div class="stat"><div class="k">Refused</div><div class="v">${denied}</div>
        <div class="sub">outside the permission</div></div>
      <div class="stat"><div class="k">Live permissions</div><div class="v">${live}</div>
        <div class="sub">shoppers who granted access</div></div>
    </div>

    <div class="panel">
      <header>
        <div><h2>Recent decisions</h2><p>Every request, including the refused ones. Open one to see what was checked.</p></div>
        <a class="btn ghost" href="/dashboard/activity">View all</a>
      </header>
      <div class="body flush">
        ${data.decisions.length === 0
          ? `<div class="empty">No agent has asked for anything yet.</div>`
          : `<div class="tablewrap"><table>
               <thead><tr><th>Intent</th><th>Decision</th><th style="text-align:right">Amount</th><th>When</th></tr></thead>
               <tbody>${rows}</tbody></table></div>`}
      </div>
    </div>

    ${data.quarantined === 0 ? "" : `<div class="panel">
      <header><div><h2>Quarantined catalogue items</h2>
        <p>Products whose text read like instructions to an agent. Still on sale to people.</p></div>
        <span class="v stepup">${data.quarantined} held back</span></header>
    </div>`}`);
}

/* -------------------------------------------------------------- activity */

export function activityPage(opts: ShellOptions, decisions: readonly DecisionRow[]): string {
  const rows = decisions.map((d) => `
    <tr>
      <td class="id"><a href="/dashboard/activity/${escape(d.intentId)}">${escape(d.intentId)}</a></td>
      <td>${verdict(d.verdict)}</td>
      <td><span class="rc">${escape(d.reasonCode)}</span></td>
      <td class="num">${rupees(d.amountPaise)}</td>
      <td style="color:var(--ink-3);white-space:nowrap">${escape(when(d.createdAt))}</td>
    </tr>`).join("");

  return shell(opts, `
    <div class="head">
      <h1>Agent activity</h1>
      <p>Every decision is written to an append only ledger with the rule that produced it.
         Refusals are recorded exactly like approvals.</p>
    </div>
    <div class="panel"><div class="body flush">
      ${decisions.length === 0
        ? `<div class="empty">Nothing yet.</div>`
        : `<div class="tablewrap"><table>
             <thead><tr><th>Intent</th><th>Decision</th><th>Reason</th>
             <th style="text-align:right">Amount</th><th>When</th></tr></thead>
             <tbody>${rows}</tbody></table></div>`}
    </div></div>`);
}

/* -------------------------------------------------------------- mandates */

export function mandatesPage(opts: ShellOptions, rows: readonly MandateRow[]): string {
  const body = rows.map((m) => `
    <tr>
      <td class="mono" style="font-size:12px">${escape(m.mandateId)}</td>
      <td><span class="state ${m.state === "live" ? "on" : "off"}">${m.state === "live" ? "Live" : escape(m.state)}</span></td>
      <td class="num">${rupees(m.spentPaise)} <span style="color:var(--ink-3)">of ${rupees(m.cumulativePaise)}</span></td>
      <td class="num">${rupees(m.silentThresholdPaise)}</td>
      <td class="num">${m.chainEntries}</td>
      <td style="color:var(--ink-3);white-space:nowrap">${escape(when(m.notAfter))}</td>
    </tr>`).join("");

  return shell(opts, `
    <div class="head">
      <h1>Permissions</h1>
      <p>What each shopper has allowed an assistant to spend. A permission can be revoked at any moment. Every purchase it authorised stays in
         the ledger.</p>
    </div>
    <div class="panel"><div class="body flush">
      ${rows.length === 0
        ? `<div class="empty">No shopper has granted an assistant access yet.</div>`
        : `<div class="tablewrap"><table>
             <thead><tr><th>Permission</th><th>State</th>
             <th style="text-align:right">Spent</th><th style="text-align:right">Asks above</th>
             <th style="text-align:right">Ledger</th><th>Expires</th></tr></thead>
             <tbody>${body}</tbody></table></div>`}
    </div></div>`);
}

/* ------------------------------------------------------------------ keys */

export interface KeyView {
  readonly apiKeyPrefix: string | null;
  readonly freshApiKey?: string;
  readonly freshFulfilToken?: string;
}

export function keysPage(opts: ShellOptions, view: KeyView): string {
  const fresh = view.freshApiKey !== undefined;
  return shell(opts, `
    <div class="head">
      <h1>API keys</h1>
      <p>Two credentials, on separate doors. Agents present the API key. Your own servers
         present the fulfilment token. Leaking one does not grant the other's reach.</p>
    </div>

    ${fresh ? `
    <div class="notice warn">
      <strong>Copy these now.</strong> Only their hashes are stored, so this is the one time they can be shown. If you lose
      them, rotate. There is no way to look them up.
    </div>
    <div class="panel">
      <header><h2>Your new credentials</h2></header>
      <div class="body">
        <div class="field">
          <label>API key <span style="font-weight:400;color:var(--ink-3)">for agents</span></label>
          <div class="secret"><span id="k1">${escape(view.freshApiKey!)}</span>
            <button type="button" onclick="copy('k1',this)">Copy</button></div>
        </div>
        <div class="field" style="margin-bottom:0">
          <label>Fulfilment token <span style="font-weight:400;color:var(--ink-3)">for your backend</span></label>
          <div class="secret"><span id="k2">${escape(view.freshFulfilToken!)}</span>
            <button type="button" onclick="copy('k2',this)">Copy</button></div>
        </div>
      </div>
    </div>
    <script>
      function copy(id, btn){
        navigator.clipboard.writeText(document.getElementById(id).textContent).then(function(){
          var was = btn.textContent; btn.textContent = "Copied"; 
          setTimeout(function(){ btn.textContent = was; }, 1400);
        });
      }
    </script>` : `
    <div class="panel">
      <header><div><h2>Live key</h2><p>Shown by prefix only. The rest is not recoverable.</p></div></header>
      <div class="body">
        <div class="secret"><span>${escape(view.apiKeyPrefix ?? "none yet")}${view.apiKeyPrefix ? "…" : ""}</span></div>
      </div>
    </div>`}

    <div class="panel">
      <header><div><h2>Rotate</h2>
        <p>Issues a new pair and stops the old one immediately. Agents still using the old key
           will be refused, so update them first.</p></div></header>
      <div class="body">
        <form method="POST" action="/dashboard/keys/rotate">
          <button class="btn danger" type="submit">Rotate both credentials</button>
        </form>
      </div>
    </div>`);
}

/* ----------------------------------------------------------- integration */

export function integrationPage(
  opts: ShellOptions,
  merchant: MerchantRecord,
  saved: boolean,
): string {
  const v = (s: string | null) => escape(s ?? "");
  return shell(opts, `
    <div class="head">
      <h1>Integration</h1>
      <p>Four URLs. Everything else about your shop stays exactly as it is.</p>
    </div>

    ${saved ? `<div class="notice ok">Saved.</div>` : ""}

    <div class="panel">
      <header><div><h2>Your endpoints</h2>
        <p>We call these. Agents never do, because they have no route to your application.</p></div></header>
      <div class="body">
        <form method="POST" action="/dashboard/integration">
          <div class="field">
            <label for="catalog">Product endpoint</label>
            <input id="catalog" name="catalog" type="url" required value="${v(merchant.catalogUrl)}">
            <p class="hint">Read only. Every field is scanned for injected instructions before an agent sees it.</p>
          </div>
          <div class="field">
            <label for="fulfil">Fulfilment endpoint</label>
            <input id="fulfil" name="fulfil" type="url" value="${v(merchant.fulfilUrl)}"
                   placeholder="https://yourshop.com/internal/agent/fulfil">
            <p class="hint">Where a paid agent order becomes a real order. Must be idempotent on <code>intent_id</code>, because we may retry and your shopper
               must not get two orders.</p>
          </div>
          <div class="field">
            <label for="authorize">Authorisation page</label>
            <input id="authorize" name="authorize" type="url" value="${v(merchant.authorizeUrl)}"
                   placeholder="https://yourshop.com/agent/authorize">
            <p class="hint">A logged-in page where a shopper picks a delivery address. We serve the consent screen from a different origin and cannot see your session.
               You can.</p>
          </div>
          <div class="field">
            <label for="site">Your website</label>
            <input id="site" name="site" type="url" required value="${v(merchant.publicBaseUrl)}">
          </div>
          <button class="btn" type="submit">Save</button>
        </form>
      </div>
    </div>

    <div class="panel">
      <header><div><h2>Discovery</h2>
        <p>One line, so an agent can find you from your own domain.</p></div></header>
      <div class="body">
<pre class="code"><span class="c">// add to your server</span>
app.get(<span class="s">'/.well-known/agent-commerce.json'</span>, (req, res) =&gt;
  res.redirect(302, <span class="s">'https://api.agentkit.dev/.well-known/agent-commerce.json'</span>));</pre>
      </div>
    </div>`);
}
