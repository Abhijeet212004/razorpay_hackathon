import { TOOLS, type ToolDefinition } from "../agent/agent.tools.js";
import { docsShell, escape, type ShellOptions } from "./dashboard.shell.js";

/**
 * The integration guide, rendered with the reading account's own ids already filled in.
 *
 * Documentation that makes you substitute placeholders is documentation people get wrong,
 * so every snippet here is copy and paste correct for the merchant looking at it.
 */

export interface DocsContext {
  readonly merchantId: string;
  readonly apiBase: string;
  readonly catalogUrl: string | null;
  readonly siteUrl: string | null;
  /** Where these pages are being served from. Public at /docs, personalised at /dashboard/docs. */
  readonly basePath?: string;
}

interface Heading {
  readonly id: string;
  readonly label: string;
  readonly sub?: boolean;
}

interface Topic {
  readonly slug: string;
  readonly title: string;
  readonly group: string;
  readonly minutes: number;
  readonly render: (ctx: DocsContext) => string;
  readonly contents: readonly Heading[];
}

const c = (text: string) => `<span class="c">${text}</span>`;
const s = (text: string) => `<span class="s">${text}</span>`;
const k = (text: string) => `<span class="k">${text}</span>`;

/** A code block with its language and a copy button, the way a docs site should. */
function code(lang: string, body: string): string {
  return `<figure class="cb"><pre>${body}</pre>
    <figcaption><span class="lang">${escape(lang)}</span>
    <button type="button">Copy</button></figcaption></figure>`;
}

function callout(title: string, body: string, kind: "" | "warn" = ""): string {
  return `<div class="callout ${kind}"><span class="ct">${escape(title)}</span>${body}</div>`;
}

/* ------------------------------------------------------------- overview */

/** The trust boundary, drawn as a boundary rather than as a stack of boxes. */
const BOUNDARY_SVG = `
<svg viewBox="0 0 760 372" role="img"
     aria-label="A dashed trust boundary around AgentKit, showing what crosses it and what does not"
     style="width:100%;max-width:760px;height:auto;margin:10px 0 8px;display:block">
  <defs>
    <marker id="a1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--ink-3)"/>
    </marker>
  </defs>
  <g font-family="Manrope,sans-serif">

    <!-- outside: the agent -->
    <text x="24" y="26" font-size="10.5" font-weight="700" letter-spacing="1.4"
          fill="var(--ink-3)">UNTRUSTED</text>
    <rect x="24" y="36" width="196" height="72" rx="4" fill="none"
          stroke="var(--line)" stroke-width="1"/>
    <text x="40" y="60" font-size="13" font-weight="700" fill="var(--ink)">The agent</text>
    <text x="40" y="78" font-size="11" fill="var(--ink-3)">Claude, or anything else</text>
    <text x="40" y="95" font-size="11" fill="var(--ink-3)">may be hostile or compromised</text>

    <!-- what it carries -->
    <line x1="220" y1="72" x2="286" y2="72" stroke="var(--ink-3)" stroke-width="1" marker-end="url(#a1)"/>
    <text x="230" y="63" font-size="10" fill="var(--ink-3)">carries only</text>
    <text x="230" y="88" font-size="10" font-family="'JetBrains Mono',monospace"
          fill="var(--accent)">a signed intent</text>

    <!-- the boundary -->
    <rect x="290" y="18" width="446" height="180" rx="6" fill="none"
          stroke="var(--accent)" stroke-width="1.2" stroke-dasharray="5 4"/>
    <text x="304" y="12" font-size="10" font-weight="700" letter-spacing="1.2"
          fill="var(--accent)">TRUST BOUNDARY</text>

    <rect x="312" y="40" width="188" height="66" rx="4" fill="var(--accent-wash)"
          stroke="var(--accent-line)"/>
    <text x="326" y="62" font-size="12.5" font-weight="800" fill="var(--accent)">Kernel</text>
    <text x="326" y="79" font-size="10.5" fill="var(--ink-2)">evaluates every rule</text>
    <text x="326" y="94" font-size="10.5" fill="var(--ink-3)">holds no payment credential</text>

    <rect x="524" y="40" width="188" height="66" rx="4" fill="none" stroke="var(--line)"/>
    <text x="538" y="62" font-size="12.5" font-weight="800" fill="var(--ink)">Executor</text>
    <text x="538" y="79" font-size="10.5" fill="var(--ink-2)">holds the payment key</text>
    <text x="538" y="94" font-size="10.5" fill="var(--ink-3)">decides nothing</text>

    <line x1="500" y1="73" x2="518" y2="73" stroke="var(--ink-3)" stroke-width="1" marker-end="url(#a1)"/>

    <rect x="312" y="122" width="400" height="58" rx="4" fill="none" stroke="var(--line)"/>
    <text x="326" y="144" font-size="12" font-weight="700" fill="var(--ink)">Append only ledger</text>
    <text x="326" y="162" font-size="10.5" fill="var(--ink-3)">every decision, with the rule that produced it, hash chained</text>

    <!-- outward calls -->
    <line x1="420" y1="198" x2="420" y2="248" stroke="var(--ink-3)" stroke-width="1" marker-end="url(#a1)"/>
    <text x="432" y="228" font-size="10" fill="var(--ink-3)">authenticated, outbound only</text>

    <text x="24" y="262" font-size="10.5" font-weight="700" letter-spacing="1.4"
          fill="var(--ink-3)">YOURS</text>
    <rect x="24" y="272" width="712" height="82" rx="4" fill="none" stroke="var(--line)"/>
    <text x="40" y="296" font-size="13" font-weight="700" fill="var(--ink)">Your application</text>
    <text x="40" y="315" font-size="11" fill="var(--ink-3)">products · customers · addresses · orders</text>
    <text x="40" y="336" font-size="11" fill="var(--ink-3)">receives requests from the kernel, never from an agent</text>

    <text x="470" y="300" font-size="10.5" font-family="'JetBrains Mono',monospace" fill="var(--ink-2)">
      GET  your catalogue</text>
    <text x="470" y="318" font-size="10.5" font-family="'JetBrains Mono',monospace" fill="var(--ink-2)">
      POST the paid order</text>
    <text x="470" y="336" font-size="10.5" font-family="'JetBrains Mono',monospace" fill="var(--ink-3)">
      opaque ids, never an address</text>
  </g>
</svg>`;

/** The lifecycle in full: every check, both failure branches, and what each writes. */
const LIFECYCLE_SVG = `
<svg viewBox="0 0 1000 830" role="img"
     aria-label="The full lifecycle of one purchase across agent, kernel, executor and merchant"
     style="width:100%;max-width:1000px;height:auto;margin:12px 0 10px;display:block">
  <defs>
    <marker id="a2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--ink-3)"/>
    </marker>
    <marker id="a3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--stop)"/>
    </marker>
    <marker id="a4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--warn)"/>
    </marker>
  </defs>
  <g font-family="Open Sans,sans-serif">

    <!-- lane headers -->
    <g font-size="11" font-weight="700" letter-spacing="1.1">
      <text x="86"  y="18" text-anchor="middle" fill="var(--ink-3)">AGENT</text>
      <text x="360" y="18" text-anchor="middle" fill="var(--accent)">KERNEL</text>
      <text x="700" y="18" text-anchor="middle" fill="var(--ink-3)">EXECUTOR</text>
      <text x="905" y="18" text-anchor="middle" fill="var(--ink-3)">YOUR SHOP</text>
    </g>
    <g stroke-dasharray="3 5" stroke-width="1">
      <line x1="86"  y1="28" x2="86"  y2="812" stroke="var(--line)"/>
      <line x1="360" y1="28" x2="360" y2="812" stroke="var(--accent-line)"/>
      <line x1="700" y1="28" x2="700" y2="812" stroke="var(--line)"/>
      <line x1="905" y1="28" x2="905" y2="812" stroke="var(--line)"/>
    </g>

    <g font-size="12" fill="var(--ink-2)">

      <!-- 1 quote -->
      <circle cx="86" cy="52" r="9" fill="var(--accent-wash)" stroke="var(--accent-line)"/>
      <text x="86" y="56" text-anchor="middle" font-size="10" font-weight="700" fill="var(--accent)">1</text>
      <line x1="98" y1="52" x2="350" y2="52" stroke="var(--ink-3)" marker-end="url(#a2)"/>
      <text x="112" y="47" font-size="12">asks for a price</text>
      <line x1="370" y1="60" x2="895" y2="60" stroke="var(--ink-3)" marker-end="url(#a2)"/>
      <text x="384" y="75" font-size="11" fill="var(--ink-3)">reads your catalogue; the agent never supplies a price</text>
      <line x1="895" y1="88" x2="374" y2="88" stroke="var(--ink-3)" marker-end="url(#a2)"/>
      <line x1="350" y1="104" x2="98" y2="104" stroke="var(--ink-3)" marker-end="url(#a2)"/>
      <text x="112" y="99" font-size="12">a signed quote, usable once</text>

      <!-- 2 intent -->
      <circle cx="86" cy="140" r="9" fill="var(--accent-wash)" stroke="var(--accent-line)"/>
      <text x="86" y="144" text-anchor="middle" font-size="10" font-weight="700" fill="var(--accent)">2</text>
      <line x1="98" y1="140" x2="350" y2="140" stroke="var(--ink-3)" marker-end="url(#a2)"/>
      <text x="112" y="135" font-size="12">signed intent, referencing that quote</text>

      <!-- 3 stateless -->
      <rect x="374" y="158" width="300" height="52" rx="4" fill="none" stroke="var(--line)"/>
      <text x="388" y="177" font-size="12" font-weight="600" fill="var(--ink)">Cheap checks, outside any transaction</text>
      <text x="388" y="196" font-size="11" fill="var(--ink-3)">signature · freshness · quote match · untrusted text</text>
      <line x1="360" y1="184" x2="370" y2="184" stroke="var(--ink-3)" marker-end="url(#a2)"/>

      <!-- 4 verifier -->
      <rect x="374" y="220" width="300" height="52" rx="4" fill="none" stroke="var(--line)"/>
      <text x="388" y="239" font-size="12" font-weight="600" fill="var(--ink)">Second opinion</text>
      <text x="388" y="258" font-size="11" fill="var(--ink-3)">can downgrade or abstain; it has no way to approve</text>

      <!-- transaction bracket -->
      <path d="M336 292 L322 292 L322 560 L336 560" fill="none" stroke="var(--accent)" stroke-width="1.4"/>
      <rect x="248" y="284" width="70" height="18" rx="3" fill="var(--accent-wash)" stroke="var(--accent-line)"/>
      <text x="283" y="297" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--accent)">BEGIN</text>
      <rect x="244" y="552" width="78" height="18" rx="3" fill="var(--accent-wash)" stroke="var(--accent-line)"/>
      <text x="283" y="565" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--accent)">COMMIT</text>
      <text x="314" y="420" text-anchor="end" font-size="10" fill="var(--ink-3)">row lock</text>
      <text x="314" y="434" text-anchor="end" font-size="10" fill="var(--ink-3)">held</text>
      <text x="314" y="452" text-anchor="end" font-size="9.5" fill="var(--ink-3)">no outbound</text>
      <text x="314" y="464" text-anchor="end" font-size="9.5" fill="var(--ink-3)">call may run</text>

      <!-- the ordered checks -->
      <g font-size="11.5">
        <circle cx="360" cy="312" r="9" fill="var(--accent-wash)" stroke="var(--accent-line)"/>
        <text x="360" y="316" text-anchor="middle" font-size="10" font-weight="700" fill="var(--accent)">3</text>
        <text x="378" y="316" fill="var(--ink)" font-weight="600">Lock the permission row</text>
        <text x="378" y="332" font-size="10.5" fill="var(--ink-3)">serialises anything else spending the same budget</text>

        <circle cx="360" cy="360" r="9" fill="var(--accent-wash)" stroke="var(--accent-line)"/>
        <text x="360" y="364" text-anchor="middle" font-size="10" font-weight="700" fill="var(--accent)">4</text>
        <text x="378" y="364" fill="var(--ink)" font-weight="600">Live, unrevoked, in date</text>
        <text x="740" y="364" font-size="10.5" font-family="'JetBrains Mono',monospace" fill="var(--stop)">MND-001·002·003</text>

        <circle cx="360" cy="396" r="9" fill="var(--accent-wash)" stroke="var(--accent-line)"/>
        <text x="360" y="400" text-anchor="middle" font-size="10" font-weight="700" fill="var(--accent)">5</text>
        <text x="378" y="400" fill="var(--ink)" font-weight="600">Merchant and category in scope</text>
        <text x="740" y="400" font-size="10.5" font-family="'JetBrains Mono',monospace" fill="var(--stop)">SCP-001·002</text>

        <circle cx="360" cy="432" r="9" fill="var(--accent-wash)" stroke="var(--accent-line)"/>
        <text x="360" y="436" text-anchor="middle" font-size="10" font-weight="700" fill="var(--accent)">6</text>
        <text x="378" y="436" fill="var(--ink)" font-weight="600">Burn the nonce</text>
        <text x="378" y="452" font-size="10.5" fill="var(--ink-3)">the primary key is the burn, so a replay collides on insert</text>
        <text x="740" y="436" font-size="10.5" font-family="'JetBrains Mono',monospace" fill="var(--stop)">INT-001</text>

        <circle cx="360" cy="480" r="9" fill="var(--accent-wash)" stroke="var(--accent-line)"/>
        <text x="360" y="484" text-anchor="middle" font-size="10" font-weight="700" fill="var(--accent)">7</text>
        <text x="378" y="484" fill="var(--ink)" font-weight="600">Sum held and captured, apply limits</text>
        <text x="378" y="500" font-size="10.5" fill="var(--ink-3)">counting only settled payments is the double spend</text>
        <text x="740" y="484" font-size="10.5" font-family="'JetBrains Mono',monospace" fill="var(--stop)">LMT-001·002·003</text>

        <circle cx="360" cy="528" r="9" fill="var(--accent-wash)" stroke="var(--accent-line)"/>
        <text x="360" y="532" text-anchor="middle" font-size="10" font-weight="700" fill="var(--accent)">8</text>
        <text x="378" y="532" fill="var(--ink)" font-weight="600">Hold the budget, write the ledger</text>
        <text x="378" y="548" font-size="10.5" fill="var(--ink-3)">INTENT · DECISION · RESERVATION, hash chained</text>
      </g>

      <!-- refusal branch -->
      <line x1="352" y1="600" x2="106" y2="600" stroke="var(--stop)" marker-end="url(#a3)"/>
      <text x="118" y="595" font-size="11.5" fill="var(--stop)" font-weight="600">DENY, with one reason code</text>
      <text x="118" y="611" font-size="10.5" fill="var(--ink-3)">the first rule to fail decides; nothing after it runs</text>

      <!-- step up branch -->
      <line x1="352" y1="640" x2="106" y2="640" stroke="var(--warn)" marker-end="url(#a4)"/>
      <text x="118" y="635" font-size="11.5" fill="var(--warn)" font-weight="600">STEP_UP, with a link for a person</text>
      <text x="118" y="651" font-size="10.5" fill="var(--ink-3)">not a failure; the agent shows it and stops</text>

      <!-- executor -->
      <circle cx="360" cy="684" r="9" fill="var(--accent-wash)" stroke="var(--accent-line)"/>
      <text x="360" y="688" text-anchor="middle" font-size="10" font-weight="700" fill="var(--accent)">9</text>
      <line x1="372" y1="684" x2="690" y2="684" stroke="var(--ink-3)" marker-end="url(#a2)"/>
      <text x="386" y="679" font-size="12">after commit, never during</text>
      <text x="712" y="679" font-size="11.5" fill="var(--ink)" font-weight="600">charges</text>
      <text x="712" y="695" font-size="10.5" fill="var(--ink-3)">the only key</text>
      <text x="712" y="709" font-size="10.5" fill="var(--ink-3)">in the system</text>

      <!-- webhook -->
      <circle cx="700" cy="734" r="9" fill="var(--accent-wash)" stroke="var(--accent-line)"/>
      <text x="700" y="738" text-anchor="middle" font-size="10" font-weight="700" fill="var(--accent)">10</text>
      <line x1="688" y1="734" x2="372" y2="734" stroke="var(--ink-3)" marker-end="url(#a2)"/>
      <text x="386" y="729" font-size="12">signature verified, then re-read from the rail</text>
      <text x="386" y="745" font-size="10.5" fill="var(--ink-3)">a signed message proves who sent it, not that money moved</text>

      <!-- fulfil -->
      <circle cx="360" cy="784" r="9" fill="var(--accent-wash)" stroke="var(--accent-line)"/>
      <text x="360" y="788" text-anchor="middle" font-size="10" font-weight="700" fill="var(--accent)">11</text>
      <line x1="372" y1="784" x2="895" y2="784" stroke="var(--ink-3)" marker-end="url(#a2)"/>
      <text x="386" y="779" font-size="12">create the order</text>
      <text x="386" y="800" font-size="10.5" fill="var(--ink-3)">two opaque ids and a basket; never an address</text>
    </g>
  </g>
</svg>`;

const overview: Topic = {
  slug: "overview",
  title: "How it works",
  group: "Getting started",
  minutes: 12,
  contents: [
    { id: "shape", label: "The shape of it" },
    { id: "boundary", label: "The trust boundary" },
    { id: "lifecycle", label: "Lifecycle of a purchase" },
    { id: "order", label: "Why the order matters", sub: true },
    { id: "safe", label: "Is it safe to let any agent in?" },
    { id: "threats", label: "Attacks, and what stops them" },
    { id: "cannot", label: "What we do not defend" },
    { id: "yours", label: "What stays yours" },
    { id: "build", label: "What you build" },
  ],
  render: (ctx) => `
<h1>How it works</h1>
<p class="sub">AgentKit sits between AI agents and your shop. It decides what an agent is
allowed to do, records why, and keeps the decision separate from the money.</p>
<p class="readtime">12 min read</p>

<h2 id="shape">The shape of it</h2>
<p class="lead">An AI agent talks only to AgentKit. AgentKit talks to you. There is no path
from the agent to your application.</p>
<p>An agent asks what you sell, and we answer by reading the product endpoint you already
have. It asks to buy something, and we decide whether that is allowed before anything moves.
If it is allowed, payment happens, and only then do we call you to create the order.</p>
<p>Your application never receives a request from an agent. It receives requests from us,
authenticated with a token that only you and we hold.</p>

<h2 id="boundary">The trust boundary</h2>
${BOUNDARY_SVG}
<p>Three things sit inside the boundary, and each is deliberately incapable of the others'
job.</p>
<ul>
  <li><strong>The kernel decides and cannot pay.</strong> It holds no payment credential at
      all. When it needs to know whether a payment really settled, it asks the executor
      rather than the payment provider, because asking directly would require a key it must
      not have.</li>
  <li><strong>The executor pays and cannot decide.</strong> It holds the only payment
      credential in the system and has no public ingress. It does what it is told by a
      component that cannot do it.</li>
  <li><strong>The ledger records and cannot be edited.</strong> Every decision, including
      every refusal, is written as a hash chained entry. Update and delete are revoked at the
      database level for every role except the owner.</li>
</ul>
<p>The agent crosses that boundary carrying one thing: an intent it signed, referencing a
price it did not set. It never holds a payment key, a database connection, or an API token
for your systems.</p>

<h2 id="lifecycle">Lifecycle of a purchase</h2>
${LIFECYCLE_SVG}
<p>Reading it from the top: the agent submits a signed intent along with a quote we issued.
Cheap checks run first, outside any transaction. Then a single database transaction opens,
takes a row lock on the permission, and does everything that touches shared state. It commits
before any money moves.</p>

<h3 id="order">Why the order matters</h3>
<p>Three placements in that sequence are load bearing, and reversing any of them is a bug
rather than a preference.</p>
<div class="tablewrap"><table>
  <thead><tr><th>Placement</th><th>Why</th><th>What breaks if reversed</th></tr></thead>
  <tbody>
    <tr><td>Cheap checks before the transaction</td>
      <td>They touch no shared state.</td>
      <td>A malformed request would hold a lock other purchases queue behind.</td></tr>
    <tr><td>Nothing external inside the lock</td>
      <td>A third party call inside a row lock serialises every purchase on that permission
          behind an API nobody controls.</td>
      <td>One slow provider stalls a shopper's whole permission.</td></tr>
    <tr><td>Reserve, commit, then pay</td>
      <td>Reserving before paying can over count, which is conservative and is reclaimed
          later.</td>
      <td>Paying before reserving under counts, which is a spending cap bypass.</td></tr>
  </tbody>
</table></div>
${callout("The rule about the lock is enforced, not documented", `<p>A flag is set for the
duration of the lock, and every HTTP client in the system checks it before opening a socket.
A call site can forget to check; it cannot opt out. This exists because "remember not to call
out here" is not a control.</p>`)}

<h2 id="safe">Is it safe to let any agent in?</h2>
<p class="lead">Yes, and that is the design goal rather than a side effect. Registration is
open on purpose.</p>
<p>Any agent can register and get an identity in seconds. That identity grants <em>nothing</em>.
It cannot browse your catalogue outside a permission's scope, cannot get a price it can act
on, and cannot spend a rupee. Between registering and being able to buy anything sits one
event that no agent can perform: a person approving a permission, on a screen we render, with
a code sent to a number they control.</p>
<p>So the question "should I let this agent in" never has to be answered by you. An
unvetted agent is refused by the same rules as a vetted one, and a vetted one that turns
hostile has no more reach than it was granted.</p>
<div class="tablewrap"><table>
  <thead><tr><th>An agent can, without asking anyone</th><th>An agent can never</th></tr></thead>
  <tbody>
    <tr><td>Register and get an identity</td><td>Grant itself a permission</td></tr>
    <tr><td>Read your public catalogue</td><td>Set or influence a price</td></tr>
    <tr><td>Ask for a quote</td><td>Name a delivery address</td></tr>
    <tr><td>Ask a human for permission</td><td>Choose which merchant's limits apply to it</td></tr>
    <tr><td>Be refused, repeatedly</td><td>Retry its way past a refusal</td></tr>
  </tbody>
</table></div>

<h2 id="threats">Attacks, and what stops them</h2>
<p>Each row is a thing someone would actually try, and the specific mechanism that answers it.</p>
<div class="tablewrap"><table>
  <thead><tr><th>Attack</th><th>What stops it</th></tr></thead>
  <tbody>
    <tr><td><strong>Agent spends beyond what was allowed</strong></td>
      <td>Limits are evaluated server side from a signed permission the agent cannot read or
          alter. It supplies quantities; every figure comes from your catalogue.</td></tr>
    <tr><td><strong>Two purchases race to use the same budget</strong></td>
      <td>A row lock on the permission serialises authorisers, and the cap is summed over
          reservations rather than settled payments. Counting only what has settled is the
          classic double spend: two requests each read a total that excludes the other.</td></tr>
    <tr><td><strong>Replaying a purchase that succeeded</strong></td>
      <td>Each intent carries a nonce whose primary key <em>is</em> the burn. A replay
          collides on insert and is refused with <code>INT-001</code>. There is no window
          where it could succeed twice.</td></tr>
    <tr><td><strong>Prompt injection hidden in a product description</strong></td>
      <td>Every catalogue field is scanned on sync. Anything that reads as instructions is
          quarantined: invisible to agents, still on sale to people. Separately, no text
          from your catalogue can reach a decision field.</td></tr>
    <tr><td><strong>The model inside the agent is compromised</strong></td>
      <td>No model output reaches a rule. The second opinion stage is structurally incapable
          of approving anything: its result type has no allow, only downgrade or abstain.</td></tr>
    <tr><td><strong>Agent buys from you but pays someone else</strong></td>
      <td>The payee is not a field an agent can supply. The merchant is fixed by the
          permission and checked before anything else, with <code>SCP-001</code>.</td></tr>
    <tr><td><strong>Agent redirects goods to its own address</strong></td>
      <td>Addresses are chosen by the shopper at permission time and referenced by id. There
          is no field for an agent to supply one.</td></tr>
    <tr><td><strong>Forged payment confirmation</strong></td>
      <td>The webhook signature is verified, and then the order is <em>re-read from the
          payment provider</em>. A correctly signed message claiming a capture is refused if
          the provider says the order was never paid. The signature proves who sent it, not
          that the money exists.</td></tr>
    <tr><td><strong>Your own backend is compromised and binds the wrong shopper</strong></td>
      <td>The permission screen displays the name and address your server signed. If it is
          not theirs, the shopper sees it and declines. We cannot verify your customer ids;
          the shopper can.</td></tr>
    <tr><td><strong>Stolen API key</strong></td>
      <td>Only hashes are stored, so a database dump yields nothing presentable. The agent
          key and your server token are separate credentials on separate doors; one does not
          substitute for the other. Rotation is immediate.</td></tr>
    <tr><td><strong>Guessing keys by probing</strong></td>
      <td>A wrong credential and a missing credential return byte identical responses, so the
          endpoint is not an oracle.</td></tr>
    <tr><td><strong>Exhausting a shopper's budget with failures</strong></td>
      <td>A refused payment releases its hold in the same transaction that records the
          failure. Without that, every rejection would quietly consume budget for a purchase
          that never happened.</td></tr>
    <tr><td><strong>Reading another merchant's data</strong></td>
      <td>Row level security is forced on every tenant table and scoped to a setting that is
          read back and verified after it is set. No role in the system can bypass it.</td></tr>
  </tbody>
</table></div>

<h2 id="cannot">What we do not defend</h2>
<p>Two things, stated plainly because finding them yourself later is worse.</p>
<ul>
  <li><strong>A shopper who grants a bad permission.</strong> If someone allows an assistant
      ₹50,000 a month for electronics, an assistant spending ₹50,000 on electronics is the
      system working. The controls make the grant explicit, bounded and revocable; they do
      not second guess it.</li>
  <li><strong>Whoever owns the infrastructure.</strong> Signing keys live in the same database
      as the data they sign, so an operator with full access could forge and re-sign. That is
      why the hosted deployment is the default: the guarantee is only as strong as the
      separation between the person deciding and the person running the machine.</li>
</ul>

<h2 id="yours">What stays yours</h2>
<p>AgentKit stores what it needs to decide, and to prove what it decided. It has nowhere to
put your business data because it has no columns for it.</p>
<div class="tablewrap"><table>
  <thead><tr><th>AgentKit holds</th><th>You hold</th></tr></thead>
  <tbody>
    <tr><td>Permissions, limits, validity</td><td>Products, prices, stock</td></tr>
    <tr><td>An append only ledger of every decision</td><td>Customers, addresses, orders</td></tr>
    <tr><td>Budget reservations and payment state</td><td>The mapping from our reference to your customer</td></tr>
  </tbody>
</table></div>
<p>A shopper appears in our records as an opaque reference <em>in your namespace</em>. When we
call your fulfilment endpoint we send <code>customer_ref</code> and
<code>fulfilment_ref</code>, which are your ids for that person and that address. We store the
reference, never the address.</p>

<h2 id="build">What you build</h2>
<p>Two endpoints and two pages. The same four whichever integration path you choose; only the
amount of code changes.</p>
<div class="tablewrap"><table>
  <thead><tr><th>What</th><th>Who calls it</th><th>Why it has to exist</th></tr></thead>
  <tbody>
    <tr><td><code>POST /agent/fulfil</code></td><td>AgentKit</td>
      <td>Turns a paid agent purchase into a real order in your system.</td></tr>
    <tr><td><code>GET /agent/authorize</code></td><td>The shopper</td>
      <td>A signed in page where they choose which address an agent may ship to.</td></tr>
    <tr><td>Connect button</td><td>The shopper</td>
      <td>Starts a permission from your account area.</td></tr>
    <tr><td>Manifest redirect</td><td>Agents</td>
      <td>One line, so an agent can discover you from your own domain.</td></tr>
  </tbody>
</table></div>
<p>Your catalogue needs no change at all. We read
<code>${escape(ctx.catalogUrl ?? "the endpoint you configured")}</code> on a schedule and never
write to it.</p>
<p>Next: <a href="${ctx.basePath ?? "/dashboard/docs"}?p=quickstart">Quickstart</a> for a working purchase today,
or <a href="${ctx.basePath ?? "/dashboard/docs"}?p=reasons">Reason codes</a> to see how a refusal is explained.</p>`,
};

/* ----------------------------------------------------------- quickstart */

const quickstart: Topic = {
  slug: "quickstart",
  title: "Quickstart",
  group: "Getting started",
  minutes: 12,
  contents: [
    { id: "before", label: "Before you start" },
    { id: "keys", label: "1 · Get your keys" },
    { id: "fulfil", label: "2 · Fulfilment endpoint" },
    { id: "authorize", label: "3 · Authorisation page" },
    { id: "connect", label: "4 · Connect button" },
    { id: "manifest", label: "5 · Discovery" },
    { id: "save", label: "6 · Save your URLs" },
    { id: "agent", label: "7 · Point an agent at it" },
    { id: "verify", label: "8 · Verify" },
    { id: "trouble", label: "Troubleshooting" },
  ],
  render: (ctx) => `
<h1>Quickstart</h1>
<p class="sub">From an empty account to an AI agent placing a real order in your system.
Most of the time is spent writing one endpoint.</p>
<p class="readtime">12 min read</p>

<h2 id="before">Before you start</h2>
<p>You need three things, and you almost certainly have all of them already:</p>
<ul>
  <li>An endpoint that lists your products as JSON.</li>
  <li>A way to create an order in your system from code.</li>
  <li>Sessions, so you can tell who is signed in.</li>
</ul>
<p>Everything below is additive. No existing route, controller or table changes.</p>

<h2 id="keys">1 · Get your keys</h2>
<p>Open <a href="/dashboard/keys">API keys</a> and press <strong>Rotate</strong>. You will
be shown two credentials exactly once.</p>
<div class="tablewrap"><table>
  <thead><tr><th>Credential</th><th>Who presents it</th><th>Where it goes</th></tr></thead>
  <tbody>
    <tr><td><code>ak_…</code> API key</td><td>Agents, on every call</td>
      <td>Given to the agent. It decides whose limits bind them.</td></tr>
    <tr><td><code>aft_…</code> Fulfilment token</td><td>Your own backend</td>
      <td>Your environment. Never leaves your server.</td></tr>
  </tbody>
</table></div>
${callout("Only hashes are stored", `<p>We keep SHA-256 of each credential, never the credential.
That means a dump of our database yields nothing you could present back to us, and it also
means we cannot show you a key again later. If you lose one, rotate.</p>`)}
${code("Shell", `${c("# .env")}
AGENTKIT_API_KEY=ak_your_key_here
AGENTKIT_FULFIL_TOKEN=aft_your_token_here
AGENTKIT_BASE_URL=${escape(ctx.apiBase)}`)}

<h2 id="fulfil">2 · Fulfilment endpoint</h2>
<p>This is the one endpoint you must write yourself, because only you know how an order is
made in your system. We call it after a purchase has been authorised <em>and paid for</em>,
so by the time your code runs the money has already moved.</p>
<p>We send you this:</p>
${code("JSON", `{
  ${s('"intent_id"')}:      ${s('"int_a1b2c3d4"')},          ${c("// deduplicate on this")}
  ${s('"customer_ref"')}:   ${s('"your-user-id"')},          ${c("// your id, from the permission")}
  ${s('"fulfilment_ref"')}: ${s('"your-address-id"')},       ${c("// your id, chosen by the shopper")}
  ${s('"items"')}:          [{ ${s('"sku"')}: ${s('"6a90…"')}, ${s('"quantity"')}: 1 }],
  ${s('"amount_paise"')}:   ${s('"6400"')},                  ${c("// what was actually charged")}
  ${s('"payment_id"')}:     ${s('"pay_TUv5MzZ…"')},
  ${s('"audit_url"')}:      ${s(`"${escape(ctx.apiBase)}/agent/audit/int_a1b2c3d4"`)}
}`)}
<p>Your handler has three responsibilities.</p>
<ol class="steps">
  <li>
    <h3>Check the token</h3>
    <p>Compare the <code>X-AgentKit-Token</code> header against your fulfilment token and
    return <code>401</code> if it does not match. Nothing else authenticates this route.</p>
  </li>
  <li>
    <h3>Be idempotent on <code>intent_id</code></h3>
    <p>If the network drops between your order being created and your response reaching us,
    we retry. Store <code>intent_id</code> on the order and return the existing one when you
    see it again. A shopper who gets two orders for one purchase is the worst outcome here.</p>
  </li>
  <li>
    <h3>Resolve the two references</h3>
    <p><code>customer_ref</code> and <code>fulfilment_ref</code> are <em>your</em> ids,
    recorded when the shopper granted the permission. Look them up in your own tables. We
    never send an address, so there is nothing to parse and nothing to leak.</p>
  </li>
</ol>
${code("JavaScript", `app.post(${s('"/internal/agent/fulfil"')}, ${k("async")} (req, res) => {
  ${k("if")} (req.get(${s('"X-AgentKit-Token"')}) !== process.env.AGENTKIT_FULFIL_TOKEN) {
    ${k("return")} res.status(401).json({ error: ${s('"unauthorised"')} });
  }

  ${k("const")} { intent_id, customer_ref, fulfilment_ref, items, amount_paise } = req.body;

  ${c("// We may retry. Return the order you already made.")}
  ${k("const")} existing = ${k("await")} Order.findOne({ intentId: intent_id });
  ${k("if")} (existing) {
    ${k("return")} res.json({ order_id: existing.id, deduplicated: ${k("true")} });
  }

  ${k("const")} user    = ${k("await")} User.findById(customer_ref);
  ${k("const")} address = ${k("await")} Address.findById(fulfilment_ref);
  ${k("if")} (!user || !address) {
    ${k("return")} res.status(404).json({ error: ${s('"unknown reference"')} });
  }

  ${k("const")} order = ${k("await")} Order.create({
    user, address, items,
    total: Number(amount_paise) / 100,
    placedBy: ${s('"agent"')},
    intentId: intent_id,
  });

  res.json({ order_id: order.id });
});`)}

<h2 id="authorize">3 · Authorisation page</h2>
<p>When a shopper grants an assistant permission, two things must be recorded: who they are,
and which address the agent may ship to. We cannot determine either. Our consent screen runs
on a different origin from your site, so your session cookie is invisible to us. Yours is not.</p>
<p>So the shopper passes through your site on the way to approving. You identify them, they
pick an address, you sign that statement, and we render it back to them for confirmation.</p>
${code("JavaScript", `${c("// GET: show the shopper their addresses")}
app.get(${s('"/agent/authorize"')}, requireLogin, ${k("async")} (req, res) => {
  ${k("const")} addresses = ${k("await")} Address.find({ user: req.user.id });
  res.render(${s('"authorize"')}, { ref: req.query.ref, addresses });
});

${c("// POST: sign who they are and where it ships, then hand them on")}
app.post(${s('"/agent/authorize"')}, requireLogin, ${k("async")} (req, res) => {
  ${k("const")} address = ${k("await")} Address.findOne({
    _id: req.body.address_id,
    user: req.user.id,           ${c("// theirs, not just any id they sent")}
  });
  ${k("if")} (!address) ${k("return")} res.status(400).send(${s('"not your address"')});

  ${k("const")} payload = Buffer.from(JSON.stringify({
    ref:            req.body.ref,
    customerRef:    req.user.id,          ${c("// from the session, never the body")}
    fulfilmentRef:  address.id,
    displayName:    req.user.name,        ${c("// shown to them, never stored by us")}
    displayAddress: format(address),
    expiresAt:      Date.now() + 600000,
  })).toString(${s('"base64url"')});

  ${k("const")} sig = crypto
    .createHmac(${s('"sha256"')}, process.env.AGENTKIT_FULFIL_TOKEN)
    .update(payload)
    .digest(${s('"base64url"')});

  res.redirect(
    \`${escape(ctx.apiBase)}/consent/\${req.body.ref}?auth=\${payload}.\${sig}\`
  );
});`)}
${callout("Why the name and address travel with it", `<p>We cannot verify that your customer
id belongs to the person standing in front of the screen; that namespace is yours. So instead
we display what you signed: <em>"Approving as Priya, delivering to 12 MG Road."</em></p>
<p>If your backend were compromised and bound the wrong shopper, the address on screen would
not be theirs and they would decline. The one party who can tell is the one we ask.</p>`)}

<h2 id="connect">4 · Connect button</h2>
<p>Somewhere in the account area, a shopper starts a permission. You call us, we return a
link, you show it to them.</p>
${code("JavaScript", `app.post(${s('"/account/assistants"')}, requireLogin, ${k("async")} (req, res) => {
  ${k("const")} response = ${k("await")} fetch(${s(`"${escape(ctx.apiBase)}/consent/request"`)}, {
    method: ${s('"POST"')},
    headers: {
      Authorization: ${s('"Bearer "')} + process.env.AGENTKIT_API_KEY,
      ${s('"Content-Type"')}: ${s('"application/json"')},
    },
    body: JSON.stringify({
      agent_id: req.body.agent_id,   ${c("// the assistant asking")}
      contact:  req.user.phone,      ${c("// where the code is sent")}
    }),
  });

  ${k("const")} { consent_url } = ${k("await")} response.json();
  res.json({ consent_url });         ${c("// show it; do not follow it for them")}
});`)}
${callout("They approve on our screen, not yours", `<p>The consent page is rendered and
processed by AgentKit. That is deliberate: a merchant able to draw its own consent screen
could mint its own permissions, and the whole point of the permission is that it came from
the shopper.</p>`)}

<h2 id="manifest">5 · Discovery</h2>
<p>One line, so an agent that knows your domain can find the gateway without being told.</p>
${code("JavaScript", `app.get(${s('"/.well-known/agent-commerce.json"')}, (req, res) =>
  res.redirect(302, ${s(`"${escape(ctx.apiBase)}/m/${escape(ctx.merchantId)}/.well-known/agent-commerce.json"`)}));`)}
${callout("Why the redirect names you", `<p>An agent knows you as a domain, not as an id. It has
heard of your shop, so it asks <code>your-domain/.well-known/agent-commerce.json</code> — that is
what a well known URI is for, and it is the one path that cannot move to us, because on our
domain the question "which merchant?" has no answer.</p>
<p>So the redirect carries your merchant id in the path. It needs no credential: a merchant id
is not a secret and grants nothing on its own. If you are self hosting, the shorter
<code>/.well-known/agent-commerce.json</code> also works, because there is only one merchant to
mean.</p>`)}

<h2 id="save">6 · Save your URLs</h2>
<p>Go to <a href="/dashboard/integration">Integration</a> and fill in the fulfilment endpoint
and the authorisation page you just wrote. Until the fulfilment URL is set, an approved
purchase cannot become an order, and the overview will keep warning you about it.</p>

<h2 id="agent">7 · Point an agent at it</h2>
${code("JSON", `${c("// Claude Desktop, claude_desktop_config.json")}
{
  ${s('"mcpServers"')}: {
    ${s(`"${escape(ctx.merchantId)}"`)}: {
      ${s('"command"')}: ${s('"npx"')},
      ${s('"args"')}: [${s('"-y"')}, ${s('"@agentkit/mcp"')}, ${s(`"${escape(ctx.apiBase)}/agent/mcp"`)}],
      ${s('"env"')}: { ${s('"AGENTKIT_API_KEY"')}: ${s('"ak_your_key_here"')} }
    }
  }
}`)}
${callout("Quit the app before editing that file", `<p>Claude Desktop keeps its configuration
in memory and writes it back when it launches. Editing the file while it is running means
your changes are discarded on the next start. Quit fully, edit, then open it.</p>`, "warn")}

<h2 id="verify">8 · Verify</h2>
<p>Work through these in order. Each one proves a different part is wired.</p>
<ol class="steps">
  <li>
    <h3>Ask the agent what you sell</h3>
    <p>It should list your catalogue. No permission is needed to browse, so this proves the
    key works and your product endpoint is reachable.</p>
  </li>
  <li>
    <h3>Ask it to buy something</h3>
    <p>It should refuse. No shopper has granted anything yet, so there is no permission to
    spend against. This is the most important thing to see fail.</p>
  </li>
  <li>
    <h3>Grant a permission</h3>
    <p>From your account area, press the connect button, open the link, choose an address
    and enter the code. Check that the confirmation screen shows <em>your</em> name and
    <em>your</em> address.</p>
  </li>
  <li>
    <h3>Ask it to buy again</h3>
    <p>The first purchase at any merchant always asks a person, so expect a step up with
    <code>STP-002</code> and an approval link. Approve it.</p>
  </li>
  <li>
    <h3>Check both sides</h3>
    <p>The order should exist in your database with your customer and your address. The
    decision should be in <a href="/dashboard/activity">Agent activity</a>, and opening it
    should show every rule that was evaluated.</p>
  </li>
</ol>

<h2 id="trouble">Troubleshooting</h2>
<div class="tablewrap"><table>
  <thead><tr><th>What you see</th><th>What it usually means</th></tr></thead>
  <tbody>
    <tr><td><code>401</code> on every agent call</td>
      <td>The API key is missing or wrong. A wrong key and a missing key answer identically,
          on purpose, so that probing cannot enumerate keys.</td></tr>
    <tr><td>Purchases approved, no orders appear</td>
      <td>The fulfilment URL is not set, or your endpoint is returning a non-2xx. Open the
          decision in Agent activity; the timeline shows whether fulfilment was attempted.</td></tr>
    <tr><td><code>MND-001</code> on every purchase</td>
      <td>The permission was granted to a different agent. Agent identity is per keypair, so
          a client that regenerates its key on restart will orphan every permission it had.</td></tr>
    <tr><td>Fulfilment says unknown reference</td>
      <td>The permission was created without binding a shopper. It must be started from a
          signed in page, not from a bare API call.</td></tr>
    <tr><td>The same order twice</td>
      <td>Your handler is not idempotent on <code>intent_id</code>.</td></tr>
  </tbody>
</table></div>`,
};

/* -------------------------------------------------------------- Node.js */

const nodeSdk: Topic = {
  slug: "node",
  title: "Node.js",
  group: "SDKs",
  minutes: 8,
  contents: [
    { id: "install", label: "Install" },
    { id: "configure", label: "Configure" },
    { id: "mount", label: "Mount the routes" },
    { id: "fulfil", label: "Fulfilment" },
    { id: "manual", label: "Signing by hand" },
    { id: "errors", label: "Handling errors" },
    { id: "types", label: "Types" },
  ],
  render: (ctx) => `
<h1>Node.js</h1>
<p class="sub">The SDK handles signing, canonicalisation and idempotency. Those are the
three things that are tedious to get right by hand and silent when you get them wrong.</p>
<p class="readtime">8 min read</p>

<h2 id="install">Install</h2>
${code("Shell", `npm install @agentkit/merchant`)}
<p>It is a client library. It holds no state, opens no database connection, and starts no
background work. Everything it does is an HTTPS call to AgentKit or a signature computed
locally.</p>

<h2 id="configure">Configure</h2>
${code("JavaScript", `${k("import")} { AgentKit } ${k("from")} ${s('"@agentkit/merchant"')};

${k("export const")} agentkit = ${k("new")} AgentKit({
  apiKey:      process.env.AGENTKIT_API_KEY,       ${c("// ak_…  agents present this")}
  fulfilToken: process.env.AGENTKIT_FULFIL_TOKEN,  ${c("// aft_… you present this")}
  baseUrl:     ${s(`"${escape(ctx.apiBase)}"`)},
});`)}
<div class="tablewrap"><table>
  <thead><tr><th>Option</th><th>Type</th><th>Required</th><th>Meaning</th></tr></thead>
  <tbody>
    <tr><td><code>apiKey</code></td><td>string</td><td>Yes</td>
      <td>Identifies your merchant on calls you make on an agent's behalf.</td></tr>
    <tr><td><code>fulfilToken</code></td><td>string</td><td>Yes</td>
      <td>Verifies calls we make to you, and signs authorisation handoffs.</td></tr>
    <tr><td><code>baseUrl</code></td><td>string</td><td>Yes</td>
      <td>Where AgentKit lives.</td></tr>
    <tr><td><code>timeoutMs</code></td><td>number</td><td>No</td>
      <td>Defaults to 15000. Applies to every outbound call.</td></tr>
  </tbody>
</table></div>

<h2 id="mount">Mount the routes</h2>
<p>One call mounts the authorisation page and the consent starter. You supply two functions
so the SDK can see your session and your addresses; it never touches your database itself.</p>
${code("JavaScript", `app.use(${s('"/agent"')}, agentkit.routes({
  ${c("// where to send the shopper next, built from config so it can never be an open redirect")}
  kernelUrl: process.env.PUBLIC_KERNEL_URL,

  ${c("// who is signed in, or null")}
  session: (req) => req.user ? { id: req.user.id, name: req.user.name } : ${k("null")},

  ${c("// the addresses that shopper may ship to")}
  addresses: ${k("async")} (userId) => {
    ${k("const")} rows = ${k("await")} Address.find({ user: userId });
    ${k("return")} rows.map((a) => ({ id: a.id, line: \`\${a.line1}, \${a.city} \${a.pincode}\` }));
  },
}));`)}
<p>That gives you <code>GET /agent/authorize</code> and <code>POST /agent/authorize</code>,
already signing the handoff correctly. If you would rather render the address picker in your
own templates, skip this and sign it yourself, as shown further down.</p>

<h2 id="fulfil">Fulfilment</h2>
<p><code>agentkit.verify()</code> is middleware. It checks the token, rejects a replayed
<code>intent_id</code> before your handler runs, and puts a parsed order on the request.</p>
${code("JavaScript", `app.post(
  ${s('"/internal/agent/fulfil"')},
  agentkit.verify(),
  ${k("async")} (req, res) => {
    ${k("const")} { intentId, customerRef, fulfilmentRef, items, amountPaise } = req.agentOrder;

    ${k("const")} user    = ${k("await")} User.findById(customerRef);
    ${k("const")} address = ${k("await")} Address.findById(fulfilmentRef);

    ${k("const")} order = ${k("await")} Order.create({
      user, address, items,
      total: Number(amountPaise) / 100,
      placedBy: ${s('"agent"')},
      intentId,                    ${c("// store it; verify() reads it back on a retry")}
    });

    res.json({ order_id: order.id });
  },
);`)}
${callout("Idempotency is not automatic", `<p><code>verify()</code> can only deduplicate what
it can see. It looks for a prior order by calling the <code>lookup</code> function you pass
it, and falls back to letting the request through if you do not supply one. Store
<code>intentId</code> on your order and give it a way to find it.</p>`, "warn")}
${code("JavaScript", `agentkit.verify({
  lookup: (intentId) => Order.findOne({ intentId }),
  present: (order) => ({ order_id: order.id, deduplicated: ${k("true")} }),
});`)}

<h2 id="manual">Signing by hand</h2>
<p>If you render your own authorisation page, mint the token directly. The customer id must
come from the session; taking it from the request body would let anyone bind a permission to
anyone.</p>
${code("JavaScript", `${k("const")} token = agentkit.authorizationToken({
  ref:            req.body.ref,
  customerRef:    req.user.id,               ${c("// session, always")}
  fulfilmentRef:  address.id,
  displayName:    req.user.name,             ${c("// rendered for the shopper to check")}
  displayAddress: format(address),           ${c("// never stored by us")}
});

res.redirect(agentkit.consentUrl(req.body.ref, token));`)}
<p>The token is an HMAC over those fields, valid for ten minutes, and bound to that one
consent reference. It cannot be lifted onto another request or replayed later.</p>
${callout("What the key actually is", `<p>The signing key is the <em>SHA-256 of your fulfilment
token</em>, not the token itself. We store only that hash, so we can verify your handoffs
without ever holding your token in a recoverable form, and every merchant ends up with a
distinct key. The SDKs do this for you. If you are signing by hand, hash the token first, hex
encode it, and use that as the HMAC key.</p>`)}

<h2 id="errors">Handling errors</h2>
<p>Every method throws <code>AgentKitError</code> with a <code>status</code> and, where we
returned one, a <code>reasonCode</code>.</p>
${code("JavaScript", `${k("try")} {
  ${k("const")} { request_ref, consent_url } = ${k("await")} agentkit.requestConsent({
    agentId, contact, requestedScope, limits,
  });
  res.json({ ref: request_ref, consentUrl: consent_url });
} ${k("catch")} (error) {
  ${k("if")} (error.status === 429) {
    ${c("// asking for permission sends a code to a phone, so it is rate limited hard")}
    ${k("return")} res.status(429).json({ error: ${s('"try again shortly"')} });
  }
  ${k("if")} (error.reasonCode === ${s('"SYS-003"')}) {
    ${k("return")} res.status(503).json({ error: ${s('"Agent commerce is paused on this account"')} });
  }
  ${k("throw")} error;
}`)}

<h2 id="types">Types</h2>
<p>The package ships its own declarations. <code>req.agentOrder</code> is typed if you widen
the Express request.</p>
${code("TypeScript", `${k("declare global")} {
  ${k("namespace")} Express {
    ${k("interface")} Request {
      agentOrder?: {
        intentId: string;
        customerRef: string;
        fulfilmentRef: string;
        items: { sku: string; quantity: number }[];
        amountPaise: string;      ${c("// a decimal string; paise are BIGINT")}
        paymentId: string;
        auditUrl: string;
      };
    }
  }
}`)}
${callout("Amounts are strings", `<p>Money is held as integer paise and crosses the wire as a
decimal string. A JSON number would lose precision at amounts you will eventually see. Convert
at the edge, and never with <code>parseFloat</code> if you can avoid it.</p>`)}`,
};

/* --------------------------------------------------------------- Python */

const pythonSdk: Topic = {
  slug: "python",
  title: "Python",
  group: "SDKs",
  minutes: 6,
  contents: [
    { id: "install", label: "Install" },
    { id: "configure", label: "Configure" },
    { id: "fulfil", label: "Fulfilment" },
    { id: "authorize", label: "Authorisation" },
    { id: "django", label: "Django" },
  ],
  render: (ctx) => `
<h1>Python</h1>
<p class="sub">Flask, FastAPI and Django. Same contract as every other SDK; only the
framework glue differs.</p>
<p class="readtime">6 min read</p>

<h2 id="install">Install</h2>
${code("Shell", `pip install agentkit-merchant`)}

<h2 id="configure">Configure</h2>
${code("Python", `${k("from")} agentkit ${k("import")} AgentKit

agentkit = AgentKit(
    api_key      = os.environ[${s('"AGENTKIT_API_KEY"')}],
    fulfil_token = os.environ[${s('"AGENTKIT_FULFIL_TOKEN"')}],
    base_url     = ${s(`"${escape(ctx.apiBase)}"`)},
)`)}

<h2 id="fulfil">Fulfilment</h2>
<p>The decorator checks the token and hands your function a parsed order. Supply
<code>lookup</code> so a retry returns the order you already made.</p>
${code("Python", `@app.post(${s('"/internal/agent/fulfil"')})
@agentkit.verify(lookup=${k("lambda")} intent_id: Order.query.filter_by(intent_id=intent_id).first())
${k("def")} fulfil(order):
    user    = User.query.get(order.customer_ref)
    address = Address.query.get(order.fulfilment_ref)
    ${k("if")} ${k("not")} user ${k("or")} ${k("not")} address:
        ${k("return")} {${s('"error"')}: ${s('"unknown reference"')}}, 404

    row = Order(
        user=user,
        address=address,
        total=Decimal(order.amount_paise) / 100,   ${c("# Decimal, not float")}
        placed_by=${s('"agent"')},
        intent_id=order.intent_id,
    )
    db.session.add(row)
    db.session.commit()
    ${k("return")} {${s('"order_id"')}: row.id}`)}
${callout("Use Decimal", `<p><code>amount_paise</code> arrives as a string of integer paise.
Dividing a float by 100 will eventually give you an order worth ₹63.99999999999999.</p>`, "warn")}

<h2 id="authorize">Authorisation</h2>
${code("Python", `@app.post(${s('"/agent/authorize"')})
@login_required
${k("def")} authorize():
    address = Address.query.filter_by(
        id=request.form[${s('"address_id"')}],
        user_id=current_user.id,          ${c("# theirs, not just any id posted")}
    ).first_or_404()

    token = agentkit.authorization_token(
        ref             = request.form[${s('"ref"')}],
        customer_ref    = current_user.id,   ${c("# session, always")}
        fulfilment_ref  = address.id,
        display_name    = current_user.name,
        display_address = format_address(address),
    )
    ${k("return")} redirect(agentkit.consent_url(request.form[${s('"ref"')}], token))`)}

<h2 id="django">Django</h2>
<p>The same two views, wired through Django's decorators.</p>
${code("Python", `${k("from")} django.views.decorators.csrf ${k("import")} csrf_exempt

@csrf_exempt                       ${c("# we authenticate with a token, not a cookie")}
@agentkit.verify(lookup=find_order_by_intent)
${k("def")} fulfil(request, order):
    ...

@login_required
${k("def")} authorize(request):
    ...`)}
${callout("Why CSRF exemption is safe here", `<p>The fulfilment route is not reachable from a
browser session. It authenticates with a bearer token that only your server and AgentKit hold,
so there is no ambient credential for a cross site request to ride. Your authorisation page,
which <em>does</em> use the session, must keep CSRF protection.</p>`)}`,
};

/* ------------------------------------------------------------------ PHP */

const phpSdk: Topic = {
  slug: "php",
  title: "PHP",
  group: "SDKs",
  minutes: 7,
  contents: [
    { id: "install", label: "What you need" },
    { id: "canonical", label: "Canonical JSON" },
    { id: "sign", label: "Signing an intent" },
    { id: "fulfil", label: "Fulfilment" },
    { id: "authorize", label: "Authorisation" },
  ],
  render: (ctx) => `
<h1>PHP</h1>
<p class="sub">There is no Composer package yet. The protocol is small enough to implement
directly, and this page is the whole of it: about eighty lines against ext-sodium, which
ships with PHP 7.2 and later.</p>
<p class="readtime">7 min read</p>

<h2 id="install">What you need</h2>
<p>Only what is already in the standard library.</p>
${code("Shell", `php -m | grep -E ${s("'sodium|json|hash'")}`)}
<p>If <code>sodium</code> is missing, install <code>php-sodium</code> from your distribution.
Nothing else is required: no Composer dependency, no HTTP client beyond cURL.</p>
${callout("Why there is no package here", `<p>We ship tested packages for Node and Python
because those are where agent integrations actually live. Rather than publish a PHP package
we do not exercise, this page documents the wire protocol exactly. Everything below is
verified against the same kernel the SDKs are tested against.</p>`)}

<h2 id="canonical">Canonical JSON</h2>
<p>Signatures cover RFC 8785 bytes, so your serialiser has to agree with ours down to key
order and escaping. This is the one part worth copying rather than improvising.</p>
${code("PHP", `${k("function")} canonicalise($value): string {
    ${k("if")} ($value === ${k("null")})  ${k("return")} ${s("'null'")};
    ${k("if")} ($value === ${k("true")})  ${k("return")} ${s("'true'")};
    ${k("if")} ($value === ${k("false")}) ${k("return")} ${s("'false'")};

    ${k("if")} (is_int($value)) ${k("return")} (string) $value;

    ${c("// Money never travels as a float. Refuse rather than sign a rounded value.")}
    ${k("if")} (is_float($value)) {
        ${k("throw new")} InvalidArgumentException(${s("'floats may not be canonicalised'")});
    }

    ${k("if")} (is_string($value)) {
        ${k("return")} json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }

    ${k("if")} (array_is_list($value)) {
        ${k("return")} ${s("'['")} . implode(${s("','")}, array_map(${s("'canonicalise'")}, $value)) . ${s("']'")};
    }

    ksort($value, SORT_STRING);
    $parts = [];
    ${k("foreach")} ($value ${k("as")} $key => $item) {
        $parts[] = json_encode((string) $key, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
                 . ${s("':'")} . canonicalise($item);
    }
    ${k("return")} ${s("'{'")} . implode(${s("','")}, $parts) . ${s("'}'")};
}`)}
${callout("Money is a string", `<p><code>amount_paise</code> is signed as a decimal string,
never a JSON number. Paise exceed PHP's integer precision on 32-bit builds long before they
exceed a realistic basket, and a float that rounds is a price that silently changed. Keep it
a string the whole way through and use <code>bcdiv</code> when you finally need rupees.</p>`, "warn")}

<h2 id="sign">Signing an intent</h2>
<p>Ten fields, no more and no fewer. An extra key changes the bytes and invalidates the
signature; so does a missing one.</p>
${code("PHP", `${k("function")} intentSigningPayload(${k("array")} $intent): ${k("array")} {
    ${k("return")} [
        ${s("'amount_paise'")} => (string) $intent[${s("'amount_paise'")}],
        ${s("'basket_hash'")}  => $intent[${s("'basket_hash'")}],
        ${s("'expires_at'")}   => $intent[${s("'expires_at'")}],
        ${s("'intent_id'")}    => $intent[${s("'intent_id'")}],
        ${s("'mandate_id'")}   => $intent[${s("'mandate_id'")}],
        ${s("'merchant_id'")}  => $intent[${s("'merchant_id'")}],
        ${s("'nonce'")}        => $intent[${s("'nonce'")}],
        ${s("'quote_id'")}     => $intent[${s("'quote_id'")}],
        ${s("'rationale'")}    => $intent[${s("'rationale'")}],
        ${s("'type'")}         => $intent[${s("'type'")}],
    ];
}

${c("// The agent's identity. Generate once, store both halves, load them at boot.")}
${c("// Regenerating on deploy orphans every mandate ever granted to the old id.")}
$keypair = sodium_crypto_sign_keypair();
$secret  = sodium_crypto_sign_secretkey($keypair);
$public  = sodium_crypto_sign_publickey($keypair);   ${c("// 32 bytes, send as hex")}

${k("function")} signIntent(string $secret, ${k("array")} $intent): string {
    $bytes = canonicalise(intentSigningPayload($intent));
    ${k("return")} bin2hex(sodium_crypto_sign_detached($bytes, $secret));
}`)}
<p>Then post it. The amount and basket come from the signed quote, never from your own
variables: the kernel checks that they match and refuses with <code>INT-003</code> if they
do not.</p>
${code("PHP", `$quote  = $signedQuote[${s("'quote'")}];
$intent = [
    ${s("'intent_id'")}   => ${s("'int_'")} . bin2hex(random_bytes(16)),
    ${s("'type'")}        => ${s("'purchase'")},
    ${s("'mandate_id'")}  => $mandateId,
    ${s("'quote_id'")}    => $quote[${s("'quote_id'")}],
    ${s("'merchant_id'")} => $quote[${s("'merchant_id'")}],
    ${s("'amount_paise'")} => $quote[${s("'amount_paise'")}],
    ${s("'basket_hash'")}  => $quote[${s("'basket_hash'")}],
    ${s("'rationale'")}   => ${s("'weekly staples'")},
    ${s("'nonce'")}       => bin2hex(random_bytes(16)),
    ${s("'expires_at'")}  => gmdate(${s("'Y-m-d\\\\TH:i:s.v\\\\Z'")}, time() + 120),
];

$body = json_encode([
    ${s("'signedIntent'")} => [
        ${s("'intent'")}    => $intent,
        ${s("'agent_id'")}  => $agentId,
        ${s("'signature'")} => signIntent($secret, $intent),
    ],
    ${s("'signedQuote'")} => $signedQuote,
]);

$ch = curl_init(${s(`'${escape(ctx.apiBase)}/agent/acp/checkout'`)});
curl_setopt_array($ch, [
    CURLOPT_POST           => ${k("true")},
    CURLOPT_POSTFIELDS     => $body,
    CURLOPT_RETURNTRANSFER => ${k("true")},
    CURLOPT_HTTPHEADER     => [
        ${s("'Content-Type: application/json'")},
        ${s("'x-agentkit-key: '")} . $apiKey,
    ],
]);
$decision = json_decode(curl_exec($ch), ${k("true")});`)}
${callout("If you get INT-001", `<p>It means the signature does not match the payload, and the
kernel will not say more than that: a signature check that explained itself would be an oracle
for forging one. In practice it is almost always canonicalisation. Print your canonical string
and compare it against the same intent run through the Node or Python SDK.</p>`, "warn")}

<h2 id="fulfil">Fulfilment</h2>
<p>Where an agent's purchase becomes a real order in your system. Verify the token in
constant time, and make the handler idempotent: a retry must return the order you already
made rather than making a second one.</p>
${code("PHP", `$presented = $_SERVER[${s("'HTTP_X_AGENTKIT_TOKEN'")}] ?? ${s("''")};
${k("if")} (! hash_equals(getenv(${s("'AGENTKIT_FULFIL_TOKEN'")}), $presented)) {
    http_response_code(401);
    ${k("exit")};
}

$order = json_decode(file_get_contents(${s("'php://input'")}), ${k("true")});

${c("// A retry returns the order we already made.")}
$existing = Order::findByIntentId($order[${s("'intent_id'")}]);
${k("if")} ($existing) {
    ${k("echo")} json_encode([${s("'order_id'")} => $existing->id]);
    ${k("exit")};
}

$row = Order::create([
    ${s("'user_id'")}    => $order[${s("'customer_ref'")}],
    ${s("'address_id'")} => $order[${s("'fulfilment_ref'")}],
    ${s("'total'")}      => bcdiv($order[${s("'amount_paise'")}], ${s("'100'")}, 2),  ${c("// bcmath, not float")}
    ${s("'placed_by'")}  => ${s("'agent'")},
    ${s("'intent_id'")}  => $order[${s("'intent_id'")}],
]);

${k("echo")} json_encode([${s("'order_id'")} => $row->id]);`)}

<h2 id="authorize">Authorisation</h2>
<p>The page where you identify the shopper before they approve a grant. Two rules it must
keep, and both are real holes if you drop them.</p>
${code("PHP", `${c("// GET renders the form. POST commits. Binding on a GET would make this")}
${c("// reachable by a link, an image tag, or a browser prefetch.")}
${k("if")} ($_SERVER[${s("'REQUEST_METHOD'")}] !== ${s("'POST'")}) {
    render_address_picker($_GET[${s("'ref'")}] ?? ${s("''")});
    ${k("exit")};
}

$ref = $_POST[${s("'ref'")}] ?? ${s("''")};

${c("// The address must be one of theirs, not just any id that was posted.")}
$address = Address::findForUser($_POST[${s("'address_id'")}], current_user()->id);
${k("if")} (! $address) {
    http_response_code(400);
    ${k("exit")};
}

$claims = [
    ${s("'ref'")}            => $ref,
    ${c("// From the session, always. Never from the request body.")}
    ${s("'customerRef'")}    => (string) current_user()->id,
    ${s("'fulfilmentRef'")}  => (string) $address->id,
    ${s("'displayName'")}    => current_user()->name,
    ${s("'displayAddress'")} => $address->oneLine(),
    ${s("'expiresAt'")}      => (time() + 600) * 1000,
];

$payload   = rtrim(strtr(base64_encode(json_encode($claims)), ${s("'+/'")}, ${s("'-_'")}), ${s("'='")});
${c("// The key is the hash of your fulfil token, not the token. We store only the hash,")}
${c("// so we can verify without ever holding your token recoverably.")}
$key = hash(${s("'sha256'")}, getenv(${s("'AGENTKIT_FULFIL_TOKEN'")}));

$signature = rtrim(strtr(base64_encode(
    hash_hmac(${s("'sha256'")}, $payload, $key, ${k("true")})
), ${s("'+/'")}, ${s("'-_'")}), ${s("'='")});

${c("// Built from configuration, never echoed from a query parameter, which would")}
${c("// turn this route into an open redirect.")}
$base = ${s(`'${escape(ctx.apiBase)}'`)};
header(${s("'Location: '")} . $base . ${s("'/consent/'")} . rawurlencode($ref)
     . ${s("'?auth='")} . rawurlencode($payload . ${s("'.'")} . $signature));`)}
${callout("Why the display fields matter", `<p>You cannot prove to the kernel that this customer
id is this person: it is your namespace and opaque to them. So the kernel shows the shopper the
name and address you claim and lets them decline if it is not theirs. The one party who can
check is the one asked to.</p>`)}`,
};

/* --------------------------------------------------------------- Docker */

const docker: Topic = {
  slug: "docker",
  title: "Docker adapter",
  group: "Other integrations",
  minutes: 7,
  contents: [
    { id: "when", label: "When to use it" },
    { id: "not", label: "What it is not" },
    { id: "run", label: "Run it" },
    { id: "contracts", label: "The three endpoints" },
    { id: "mapping", label: "Mapping your fields" },
    { id: "verify", label: "Verify" },
  ],
  render: (ctx) => `
<h1>Docker adapter</h1>
<p class="sub">A container beside your application that translates your existing endpoints
into ours. No code changes at all.</p>
<p class="readtime">7 min read</p>

<h2 id="when">When to use it</h2>
<p>Use it when your product, order and session endpoints already exist and you would rather
configure than write code. It is also how the Shopify and WooCommerce plugins work: those
platforms expose the three endpoints with known shapes, so the adapter is configured once
per platform rather than once per shop.</p>

<h2 id="not">What it is not</h2>
<p>The adapter is a translator. It holds no permission, no limit and no ledger, and it makes
no decision. Those stay with AgentKit, which is what makes them something a compromised
merchant cannot quietly rewrite.</p>
${callout("The adapter is inside your trust boundary", `<p>It sits on your network and holds
your fulfilment token, so treat it as part of your application rather than as a third party
service. It never needs inbound access from the internet.</p>`)}

<h2 id="run">Run it</h2>
${code("YAML", `${c("# docker-compose.yml, alongside your app")}
services:
  agentkit-adapter:
    image: ghcr.io/abhijeet212004/agentkit-adapter:1
    restart: unless-stopped
    environment:
      AGENTKIT_API_KEY:      ${s("${AGENTKIT_API_KEY}")}
      AGENTKIT_FULFIL_TOKEN: ${s("${AGENTKIT_FULFIL_TOKEN}")}
      AGENTKIT_BASE_URL:     ${escape(ctx.apiBase)}

      ${c("# your existing endpoints, reachable on the internal network")}
      MERCHANT_PRODUCTS_URL: http://app:3000/api/products
      MERCHANT_ORDERS_URL:   http://app:3000/api/orders
      MERCHANT_SESSION_URL:  http://app:3000/api/me

      ${c("# your field names, as dotted paths into your own responses")}
      PRODUCTS_ROOT:      data.items
      PRODUCT_ID:         id
      PRODUCT_NAME:       title
      PRODUCT_CATEGORY:   category.name
      PRODUCT_PRICE:      price.amount
      PRODUCT_PRICE_UNIT: paise        ${c("# or rupees. Getting this wrong charges 100x")}
      PRODUCT_STOCK:      inventory.count
    ports:
      - ${s('"7000:7000"')}
    depends_on:
      - app`)}
<p>Then point the two dashboard fields at the adapter rather than at your app:</p>
<div class="tablewrap"><table>
  <thead><tr><th>Dashboard field</th><th>Value</th></tr></thead>
  <tbody>
    <tr><td>Fulfilment endpoint</td><td><code>https://yourdomain.com/agentkit/fulfil</code></td></tr>
    <tr><td>Authorisation page</td><td><code>https://yourdomain.com/agentkit/authorize</code></td></tr>
  </tbody>
</table></div>
<p>Proxy those two paths to the adapter on port 7000. Everything else on your domain is
untouched.</p>

<h2 id="contracts">The three endpoints</h2>

<h3>Products, read only</h3>
<p>The adapter polls this and forwards the result. Anything your API already returns is fine
as long as the four fields can be found.</p>
${code("HTTP", `GET /api/products

200 {
  ${s('"products"')}: [
    { ${s('"_id"')}: ${s('"p_1"')}, ${s('"name"')}: ${s('"Full Cream Milk 1L"')},
      ${s('"category"')}: ${s('"groceries"')}, ${s('"price"')}: 64 }
  ]
}`)}

<h3>Orders, written after payment</h3>
<p>The adapter translates our fulfilment payload into a call your API already accepts.</p>
${code("HTTP", `POST /api/orders

{
  ${s('"user_id"')}:    ${s('"usr_123"')},
  ${s('"address_id"')}: ${s('"addr_9"')},
  ${s('"items"')}:      [{ ${s('"product_id"')}: ${s('"p_1"')}, ${s('"quantity"')}: 1 }],
  ${s('"total"')}:      64,
  ${s('"reference"')}:  ${s('"int_a1b2c3d4"')}   ${c("// store it; the adapter retries on this")}
}

200 { ${s('"id"')}: ${s('"ord_77"')} }`)}

<h3>Session, so a permission binds to a person</h3>
<p>Called with the shopper's cookies forwarded, when they visit the authorisation page.</p>
${code("HTTP", `GET /api/me                 ${c("# cookies forwarded from the browser")}

200 {
  ${s('"id"')}:   ${s('"usr_123"')},
  ${s('"name"')}: ${s('"Priya"')},
  ${s('"addresses"')}: [
    { ${s('"id"')}: ${s('"addr_9"')}, ${s('"line"')}: ${s('"12 MG Road, Pune 411001"')} }
  ]
}

401 ${c("# not signed in; the adapter sends them to your login page")}`)}

<h2 id="mapping">Mapping your fields</h2>
<p>If your field names differ, tell the adapter rather than changing your API.</p>
${code("YAML", `      MAP_PRODUCT_ID:       _id
      MAP_PRODUCT_NAME:     title
      MAP_PRODUCT_PRICE:    price_inr
      MAP_PRODUCT_CATEGORY: department
      MAP_PRODUCT_LIST:     data.items      ${c("# where the array lives in the response")}

      MAP_ORDER_REFERENCE:  external_ref
      MAP_ORDER_TOTAL:      amount`)}
<div class="tablewrap"><table>
  <thead><tr><th>We need</th><th>Default</th><th>Meaning</th></tr></thead>
  <tbody>
    <tr><td><code>sku</code></td><td><code>_id</code></td>
      <td>Stable identifier. An agent quotes against this, so it must not change.</td></tr>
    <tr><td><code>name</code></td><td><code>name</code></td><td>Shown to the shopper.</td></tr>
    <tr><td><code>price</code></td><td><code>price</code></td>
      <td>In rupees. Always your price; an agent never supplies one.</td></tr>
    <tr><td><code>category</code></td><td><code>category</code></td>
      <td>Checked against the permission's scope.</td></tr>
  </tbody>
</table></div>

<h2 id="verify">Verify</h2>
${code("Shell", `${c("# is the adapter reaching your app?")}
docker compose exec agentkit-adapter agentkit doctor

${c("# expected")}
products   ok    11 items, 0 quarantined
orders     ok    reachable
session    ok    returns 401 when signed out
agentkit   ok    authenticated as ${escape(ctx.merchantId)}`)}`,
};

/* ------------------------------------------------------------- REST API */


/**
 * The endpoint reference, generated from the tool manifest rather than written beside it.
 *
 * TOOLS is what /agent/tools serves and what MCP exposes, so generating this table from it
 * means the documentation cannot describe an endpoint the kernel does not have, or miss one
 * it does. A tool added to that list appears here on the next render.
 */
const CLASS_NOTE: Record<string, string> = {
  read: "Costs nothing. Always available to a registered agent.",
  propose: "Costs nothing, because a proposal is only words.",
  money: "Spends the shopper's money. Always through the policy engine.",
  margin: "Spends the merchant's margin, bounded by the promo budget.",
};

function toolReference(tool: ToolDefinition): string {
  const inputs = Object.entries(tool.input)
    .map(([name, note]) => `<tr><td><code>${escape(name)}</code></td><td>${escape(note)}</td></tr>`)
    .join("");

  const denials = (tool.denials ?? []).length === 0
    ? ""
    : `<p class="denials">Can refuse with ${(tool.denials ?? [])
        .map((d) => `<code>${escape(d)}</code>`).join(", ")}.</p>`;

  return `
<div class="endpoint">
  <h3 id="tool-${escape(tool.name)}"><code>${escape(tool.name)}</code>
    <span class="pill pill-${escape(tool.class)}">${escape(tool.class)}</span></h3>
  <p class="verb"><code>${escape(tool.method)} ${escape(tool.path)}</code></p>
  <p>${escape(tool.description)}</p>
  <div class="tablewrap"><table>
    <thead><tr><th>Field</th><th>Meaning</th></tr></thead>
    <tbody>${inputs}</tbody>
  </table></div>
  ${denials}
</div>`;
}

function endpointIndex(): string {
  const rows = TOOLS.map((tool) => `<tr>
      <td><code>${escape(tool.method)}</code></td>
      <td><a href="#tool-${escape(tool.name)}"><code>${escape(tool.path)}</code></a></td>
      <td><span class="pill pill-${escape(tool.class)}">${escape(tool.class)}</span></td>
      <td>${escape(tool.name)}</td>
    </tr>`).join("");

  return `<div class="tablewrap"><table>
    <thead><tr><th>Method</th><th>Path</th><th>Class</th><th>Tool</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

const rest: Topic = {
  slug: "rest",
  title: "REST API",
  group: "Other integrations",
  minutes: 9,
  contents: [
    { id: "auth", label: "Authentication" },
    { id: "endpoints", label: "Every endpoint" },
    { id: "reference", label: "Endpoint reference" },
    { id: "other", label: "Outside the tool surface" },
    { id: "consent", label: "Start a permission" },
    { id: "status", label: "Check a permission" },
    { id: "fulfil", label: "Fulfilment callback" },
    { id: "handoff", label: "Authorisation handoff" },
    { id: "errors", label: "Errors" },
    { id: "idem", label: "Idempotency and retries" },
  ],
  render: (ctx) => `
<h1>REST API</h1>
<p class="sub">For Go, Rust, Elixir, or anywhere you would rather not take a dependency.
Everything the SDKs do, they do through this.</p>
<p class="readtime">9 min read</p>

<h2 id="auth">Authentication</h2>
<p>Two credentials on two separate doors. Leaking one does not grant the other's reach, and
presenting one at the other's door fails as though it were never issued.</p>
<div class="tablewrap"><table>
  <thead><tr><th>Header</th><th>Credential</th><th>Used for</th></tr></thead>
  <tbody>
    <tr><td><code>Authorization: Bearer ak_…</code></td><td>API key</td>
      <td>Calls you make on an agent's behalf, and calls agents make directly.</td></tr>
    <tr><td><code>X-AgentKit-Token: aft_…</code></td><td>Fulfilment token</td>
      <td>Verifying calls we make to you, and signing authorisation handoffs.</td></tr>
  </tbody>
</table></div>

<h2 id="endpoints">Every endpoint</h2>
<p>The agent surface in full. This table is generated from the same manifest the kernel
serves at <code>${escape(ctx.apiBase)}/agent/tools</code> and that MCP exposes, so it cannot
describe an endpoint that does not exist or miss one that does.</p>
${endpointIndex()}
${callout("Class is a permission, not a label", `<p><strong>read</strong> costs nothing and is
always available. <strong>propose</strong> also costs nothing, because a proposal is only
words. <strong>money</strong> spends the shopper's money and always goes through the policy
engine. <strong>margin</strong> spends yours, bounded by the promo budget. The list can grow
without the blast radius growing with it, because a new read tool is still only a read.</p>`)}

<h2 id="reference">Endpoint reference</h2>
${TOOLS.map(toolReference).join("")}

<h2 id="other">Outside the tool surface</h2>
<p>These are not agent tools. They are the endpoints your own systems and the shopper's
browser use.</p>
<div class="tablewrap"><table>
  <thead><tr><th>Method</th><th>Path</th><th>Who calls it</th></tr></thead>
  <tbody>
    <tr><td><code>GET</code></td><td><code>/health</code></td><td>Your orchestrator.</td></tr>
    <tr><td><code>GET</code></td><td><code>/.well-known/agent-commerce.json</code></td>
      <td>Any agent, to discover the rest. No credential needed. Resolves to the single
      merchant on a self hosted deployment.</td></tr>
    <tr><td><code>GET</code></td><td><code>/m/:merchant_id/.well-known/agent-commerce.json</code></td>
      <td>The same manifest, addressed by merchant. This is what your own domain's
      well known path redirects to when the kernel serves more than one shop.</td></tr>
    <tr><td><code>GET</code></td><td><code>/agent/tools</code></td>
      <td>Any agent, for the manifest this page is generated from.</td></tr>
    <tr><td><code>GET</code></td><td><code>/agent/audit/:intent_id</code></td>
      <td>Anyone holding the intent id. The public record of one decision, which is what
      every <code>audit_url</code> points at. No credential: the reader is usually a shopper
      or a support desk, and neither holds a key. The id is a random UUID, so knowing it is
      the capability.</td></tr>
    <tr><td><code>POST</code></td><td><code>/agent/mcp</code></td>
      <td>An MCP client, over JSON-RPC. Same tools, different door.</td></tr>
    <tr><td><code>POST</code></td><td><code>/agent/webhooks/razorpay</code></td>
      <td>Razorpay. A notification, never an instruction: a capture claim is checked against
      the provider before it is believed.</td></tr>
    <tr><td><code>GET</code>, <code>POST</code></td><td><code>/consent/:ref</code></td>
      <td>The shopper's browser. The consent screen itself.</td></tr>
    <tr><td><code>POST</code></td><td><code>/consent/:ref/verify</code></td>
      <td>The shopper, entering the code.</td></tr>
    <tr><td><code>POST</code></td><td><code>/consent/:ref/reject</code></td>
      <td>The shopper, declining.</td></tr>
    <tr><td><code>POST</code></td><td><code>/consent/:ref/bind</code></td>
      <td>Your backend, binding the request to a real customer. Merchant door.</td></tr>
    <tr><td><code>GET</code>, <code>POST</code></td><td><code>/agent/approve/:challenge</code></td>
      <td>The shopper, clearing a step up.</td></tr>
    <tr><td><code>GET</code></td><td><code>/pay/:intentId</code></td>
      <td>The shopper, paying for an authorised purchase.</td></tr>
    <tr><td><code>GET</code>, <code>POST</code></td><td><code>/mandate/:id/instrument/*</code></td>
      <td>The shopper, attaching or skipping a payment instrument.</td></tr>
  </tbody>
</table></div>

<h2 id="consent">Start a permission</h2>
${code("HTTP", `POST ${escape(ctx.apiBase)}/consent/request
Authorization: Bearer ak_…
Content-Type: application/json

{
  ${s('"agent_id"')}: ${s('"agt_…"')},              ${c("// the assistant asking")}
  ${s('"contact"')}:  ${s('"+919876543210"')}       ${c("// where the one time code is sent")}
}`)}
${code("HTTP", `200 OK

{
  ${s('"request_ref"')}: ${s('"creq_91604c4b…"')},
  ${s('"consent_url"')}: ${s('"https://yourshop.com/agent/authorize?ref=creq_91604c4b…"')}
}`)}
<p>The URL points at <em>your</em> authorisation page, not ours, because the shopper has to
pass through a page that can see your session before they approve. Show them the link. Do
not follow it on their behalf.</p>

<h2 id="status">Check a permission</h2>
<p>Poll after the shopper approves. Until they do, <code>granted</code> is false and there is
no permission to spend against.</p>
${code("HTTP", `GET ${escape(ctx.apiBase)}/consent/creq_91604c4b…/status
Authorization: Bearer ak_…

200 {
  ${s('"granted"')}:    ${k("true")},
  ${s('"mandate_id"')}: ${s('"mnd_b7776d80…"')},
  ${s('"limits"')}: {
    ${s('"per_transaction_paise"')}: ${s('"200000"')},
    ${s('"cumulative_paise"')}:      ${s('"800000"')},
    ${s('"silent_threshold_paise"')}: ${s('"50000"')}
  }
}`)}

<h2 id="fulfil">Fulfilment callback</h2>
<p>We call this once a purchase is authorised and paid. Return the order you created.</p>
${code("HTTP", `POST https://yourshop.com/internal/agent/fulfil
X-AgentKit-Token: aft_…
Content-Type: application/json

{
  ${s('"intent_id"')}:      ${s('"int_a1b2c3d4"')},
  ${s('"customer_ref"')}:   ${s('"your-user-id"')},
  ${s('"fulfilment_ref"')}: ${s('"your-address-id"')},
  ${s('"items"')}:          [{ ${s('"sku"')}: ${s('"p_1"')}, ${s('"quantity"')}: 1 }],
  ${s('"amount_paise"')}:   ${s('"6400"')},
  ${s('"payment_id"')}:     ${s('"pay_TUv5MzZ…"')},
  ${s('"audit_url"')}:      ${s(`"${escape(ctx.apiBase)}/agent/audit/int_a1b2c3d4"`)}
}`)}
<div class="tablewrap"><table>
  <thead><tr><th>Field</th><th>Type</th><th>Notes</th></tr></thead>
  <tbody>
    <tr><td><code>intent_id</code></td><td>string</td>
      <td>The deduplication key. Store it on the order.</td></tr>
    <tr><td><code>customer_ref</code></td><td>string</td>
      <td>Your customer id, recorded when the permission was granted.</td></tr>
    <tr><td><code>fulfilment_ref</code></td><td>string</td>
      <td>Your address id, chosen by the shopper. We never hold the address.</td></tr>
    <tr><td><code>items</code></td><td>array</td>
      <td><code>sku</code> is whatever your product endpoint called it.</td></tr>
    <tr><td><code>amount_paise</code></td><td>string</td>
      <td>Integer paise as a decimal string. Never parse it as a float.</td></tr>
    <tr><td><code>audit_url</code></td><td>string</td>
      <td>Every rule that was evaluated for this purchase.</td></tr>
  </tbody>
</table></div>
<p>Reply <code>200</code> with <code>{"order_id": "…"}</code>. Any non-2xx is treated as a
failure and retried with the same <code>intent_id</code>.</p>

<h2 id="handoff">Authorisation handoff</h2>
<p>Build the token yourself: base64url of the claims, a dot, then base64url of an HMAC-SHA256
over that payload keyed with your fulfilment token.</p>
${code("HTTP", `payload = base64url({
  ${s('"ref"')}:            ${s('"creq_91604c4b…"')},
  ${s('"customerRef"')}:    ${s('"your-user-id"')},      ${c("// from the session")}
  ${s('"fulfilmentRef"')}:  ${s('"your-address-id"')},
  ${s('"displayName"')}:    ${s('"Priya"')},             ${c("// rendered for them to check")}
  ${s('"displayAddress"')}: ${s('"12 MG Road, Pune 411001"')},
  ${s('"expiresAt"')}:      1787842391000
})

signature = base64url(hmac_sha256(fulfil_token, payload))

redirect to ${escape(ctx.apiBase)}/consent/{ref}?auth={payload}.{signature}`)}
${callout("The display fields are rendered, never stored", `<p>We show the shopper the name and
address you signed so they can confirm it is theirs. We do not keep either. The permission
records only your two opaque references.</p>`)}

<h2 id="errors">Errors</h2>
<div class="tablewrap"><table>
  <thead><tr><th>Status</th><th>Meaning</th><th>What to do</th></tr></thead>
  <tbody>
    <tr><td><code>400</code></td><td>Malformed request</td><td>Fix the payload. Retrying will not help.</td></tr>
    <tr><td><code>401</code></td><td>Credential missing or unrecognised</td>
      <td>Check the key. A wrong key and a missing key answer identically so that probing
          cannot enumerate keys.</td></tr>
    <tr><td><code>403</code></td><td>Merchant suspended</td><td>Contact support. Retrying will not help.</td></tr>
    <tr><td><code>404</code></td><td>No such reference</td><td>The permission or intent does not exist for you.</td></tr>
    <tr><td><code>409</code></td><td>Already decided</td><td>Read the outcome. Do not retry.</td></tr>
    <tr><td><code>429</code></td><td>Rate limited</td><td>Wait <code>retry_after_seconds</code>.</td></tr>
  </tbody>
</table></div>
<p>A refused purchase is <strong>not</strong> an error. It returns <code>200</code> with a
verdict and a reason code, because the agent is being told the outcome of a decision rather
than that its request was malformed.</p>
${code("HTTP", `200 {
  ${s('"verdict"')}:     ${s('"DENY"')},
  ${s('"reason_code"')}: ${s('"SCP-002"')},
  ${s('"intent_id"')}:   ${s('"int_a1b2c3d4"')}
}`)}

<h2 id="idem">Idempotency and retries</h2>
<p>Assume every call can arrive twice. The network between us can fail after your code has
committed and before your response reaches us, and we cannot distinguish that from your
service being down.</p>
<ul>
  <li><strong>Fulfilment</strong> is keyed on <code>intent_id</code>. Store it and return the
      existing order rather than creating a second one.</li>
  <li><strong>Purchases</strong> are keyed on the intent nonce, which is spent when it is
      first seen. A replayed purchase is refused with <code>INT-001</code>, never charged twice.</li>
  <li><strong>Permissions</strong> are keyed on the consent reference. Requesting the same one
      twice returns the same reference rather than sending a second code.</li>
</ul>`,
};

/* ---------------------------------------------------------- reason codes */

const reasons: Topic = {
  slug: "reasons",
  title: "Reason codes",
  group: "Reference",
  minutes: 6,
  contents: [
    { id: "reading", label: "How to read a decision" },
    { id: "refusals", label: "Refusals" },
    { id: "stepup", label: "Step up" },
    { id: "system", label: "System" },
    { id: "agents", label: "What an agent should do" },
  ],
  render: () => `
<h1>Reason codes</h1>
<p class="sub">Every decision carries exactly one. This is what each means and what an agent
should do about it.</p>
<p class="readtime">6 min read</p>

<h2 id="reading">How to read a decision</h2>
<p>Rules are evaluated in a fixed order and the first failure decides the outcome. Nothing
after it runs. That is why a refusal always names one reason rather than a list, and why the
order matters: a request that is both out of scope and over the limit is refused for scope,
because scope is checked first.</p>
<p>Open any row in <a href="/dashboard/activity">Agent activity</a> to see the full evaluation
for a real decision, including what each rule observed and what it was checked against.</p>

<h2 id="refusals">Refusals</h2>
<p>A refusal is final for that request. The agent must not retry the same thing.</p>
<div class="tablewrap"><table>
  <thead><tr><th>Code</th><th>Meaning</th><th>Cause</th></tr></thead>
  <tbody>
    <tr><td><code>SCP-001</code></td><td>Merchant out of scope</td>
      <td>The permission does not cover this shop.</td></tr>
    <tr><td><code>SCP-002</code></td><td>Category out of scope</td>
      <td>Groceries were allowed; the basket contains electronics.</td></tr>
    <tr><td><code>LMT-001</code></td><td>Over the per order limit</td>
      <td>A single purchase larger than the shopper allowed.</td></tr>
    <tr><td><code>LMT-002</code></td><td>Over the window cap</td>
      <td>Would take total spend past the cap for this period.</td></tr>
    <tr><td><code>LMT-003</code></td><td>Too fast</td>
      <td>More purchases in an hour than the permission allows.</td></tr>
    <tr><td><code>LMT-005</code></td><td>Rate limited</td>
      <td>Too many calls. Not a purchase decision; back off and retry.</td></tr>
    <tr><td><code>INT-001</code></td><td>Request already used</td>
      <td>The intent nonce was already spent. This is the replay guard.</td></tr>
    <tr><td><code>INT-002</code></td><td>Request malformed or expired</td>
      <td>Signature, shape or freshness failed. Build a new one.</td></tr>
    <tr><td><code>MND-001</code></td><td>Permission is not this agent's</td>
      <td>Common cause: the agent regenerated its keypair and orphaned its permissions.</td></tr>
    <tr><td><code>MND-002</code></td><td>Permission revoked</td>
      <td>The shopper withdrew it. Ask for a new one.</td></tr>
    <tr><td><code>MND-003</code></td><td>Permission expired</td>
      <td>Past its validity window. Ask for a new one.</td></tr>
    <tr><td><code>AUT-001</code></td><td>No verified approval behind the permission</td>
      <td>The grant cannot be traced to a real authorisation event.</td></tr>
    <tr><td><code>SEC-001</code></td><td>Signature failed</td><td>The intent was not signed by this agent.</td></tr>
    <tr><td><code>SEC-004</code></td><td>Request did not match what was asked for</td>
      <td>The blind verifier objected. Restate the request in the shopper's terms.</td></tr>
  </tbody>
</table></div>

<h2 id="stepup">Step up</h2>
<p>A step up is not a failure. The purchase is legitimate, but large enough or new enough
that a person should see it. The response carries an <code>approval_url</code>.</p>
<div class="tablewrap"><table>
  <thead><tr><th>Code</th><th>Meaning</th></tr></thead>
  <tbody>
    <tr><td><code>STP-001</code></td>
      <td>Above the amount the shopper said could be spent without asking.</td></tr>
    <tr><td><code>STP-002</code></td>
      <td>First purchase at this merchant on this permission. Always asks, once.</td></tr>
  </tbody>
</table></div>
${callout("Do not retry a step up", `<p>Retrying produces another step up and another link,
and now the shopper has two. The correct behaviour is to show the link once and stop, then
check the order's status.</p>`, "warn")}

<h2 id="system">System</h2>
<div class="tablewrap"><table>
  <thead><tr><th>Code</th><th>Meaning</th><th>What to do</th></tr></thead>
  <tbody>
    <tr><td><code>SYS-002</code></td><td>A required check could not run</td>
      <td>We fail closed rather than guess. Retry shortly.</td></tr>
    <tr><td><code>SYS-003</code></td><td>Merchant is suspended</td>
      <td>Nothing an agent can do. The merchant should contact support.</td></tr>
  </tbody>
</table></div>

<h2 id="agents">What an agent should do</h2>
<div class="tablewrap"><table>
  <thead><tr><th>Outcome</th><th>Correct behaviour</th></tr></thead>
  <tbody>
    <tr><td><code>ALLOW</code></td><td>Proceed. The purchase is being made.</td></tr>
    <tr><td><code>STEP_UP</code></td>
      <td>Show the approval link to the person and stop. Do not retry, do not poll aggressively.</td></tr>
    <tr><td><code>DENY</code>, scope or mandate</td>
      <td>Do not retry. Explain, and offer to ask for a wider permission.</td></tr>
    <tr><td><code>DENY</code>, limits</td>
      <td>Do not retry at that amount. A smaller basket may pass; suggest one.</td></tr>
    <tr><td><code>DENY</code>, <code>INT-001</code></td>
      <td>Never retry. Build a fresh intent if the purchase is still wanted.</td></tr>
    <tr><td><code>429</code></td><td>Back off for <code>retry_after_seconds</code>.</td></tr>
  </tbody>
</table></div>`,
};

const TOPICS: readonly Topic[] = [
  overview, quickstart, nodeSdk, pythonSdk, phpSdk, docker, rest, reasons,
];

export function docsPage(opts: ShellOptions, ctx: DocsContext, slug: string): string {
  const topic = TOPICS.find((t) => t.slug === slug) ?? overview;
  const base = ctx.basePath ?? "/dashboard/docs";

  const groups = [...new Set(TOPICS.map((t) => t.group))];
  const sidebar = groups
    .map(
      (group) =>
        `<div class="gt">${escape(group)}</div>` +
        TOPICS.filter((t) => t.group === group)
          .map(
            (t) =>
              `<a href="${base}?p=${t.slug}"${t.slug === topic.slug ? ' aria-current="page"' : ""}>${escape(t.title)}</a>`,
          )
          .join(""),
    )
    .join("");

  const contents =
    topic.contents.length === 0
      ? ""
      : `<div class="gt">On this page</div>` +
        topic.contents
          .map(
            (i) =>
              `<a class="${i.sub === true ? "sub" : ""}" href="#${i.id}">${escape(i.label)}</a>`,
          )
          .join("");

  return docsShell(opts, sidebar, contents, topic.render(ctx));
}
