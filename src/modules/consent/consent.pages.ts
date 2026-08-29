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
  /**
   * Who the merchant says is approving, and where they say the order goes.
   *
   * We cannot verify either — customer and address ids belong to the merchant's own
   * namespace. The shopper can, and this is the only screen where they get the chance:
   * if this is not their name and not their address, the merchant has bound the wrong
   * person and they should decline. Rendered, never stored.
   */
  approving?: { name: string; address: string },
): string {
  const body = `
    <h1>Let ${escape(view.agentName)} shop for you?</h1>
    <p class="sub">at ${escape(view.merchantName)}</p>

    ${approving === undefined ? "" : `<div class="card">
      <div class="row"><span class="k">Approving as</span>
        <span class="v">${escape(approving.name)}</span></div>
      <div class="row"><span class="k">Delivering to</span>
        <span class="v">${escape(approving.address)}</span></div>
    </div>
    <p class="note" style="margin-top:-8px">
      If that is not you or not your address, do not continue — press Not now.
    </p>`}

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

export interface InstrumentView {
  readonly mandateId: string;
  readonly merchantName: string;
  readonly agentName: string;
  readonly maxAmountPaise: Paise;
  readonly perTransactionPaise: Paise;
  readonly returnTo?: string;
}

/**
 * Where the shopper attaches a way to pay.
 *
 * The picker itself is Razorpay's, opened in an overlay, and the approval after it
 * happens inside the shopper's own banking app. No card number, UPI id or PIN is ever
 * typed into a page we serve — all that comes back here is a token id.
 *
 * Skipping is allowed and says so plainly. A mandate with no instrument still authorises;
 * it simply cannot pay, and the agent will be told exactly that.
 */
export function instrumentPage(view: InstrumentView, keyId: string): string {
  const body = `
    <h1>Add a way to pay</h1>
    <p class="sub">so ${escape(view.agentName)} can buy without asking every time</p>

    <div class="card">
      <div class="row"><span class="k">Your bank allows up to</span>
        <span class="v">${rupees(view.maxAmountPaise)}</span></div>
      <div class="row"><span class="k">We allow, per order</span>
        <span class="v">${rupees(view.perTransactionPaise)}</span></div>
      <div class="row"><span class="k">Charged to</span>
        <span class="v">${escape(view.merchantName)}</span></div>
    </div>

    <p class="note" style="margin-top:0">
      Your bank records the first figure. We enforce the second, and it is the one you can
      revoke at any moment without opening a banking app.
    </p>

    <button id="paycard" type="button">Set up autopay with a card</button>
    <button id="pay" class="ghost" type="button">Use UPI autopay instead</button>
    <form method="POST" action="/mandate/${escape(view.mandateId)}/instrument/skip${
      view.returnTo === undefined ? "" : `?return=${encodeURIComponent(view.returnTo)}`
    }">
      <button class="ghost" type="submit">Skip for now</button>
    </form>
    <p class="note" id="status"></p>

    <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
    <script>
      (function () {
        var button = document.getElementById("pay");
        var cardButton = document.getElementById("paycard");
        var status = document.getElementById("status");
        var mandate = ${JSON.stringify(view.mandateId)};

        async function begin(method) {
          button.disabled = true;
          cardButton.disabled = true;
          status.textContent = "Opening your bank...";
          try {
            var started = await fetch(
              "/mandate/" + mandate + "/instrument/start?method=" + method,
              { method: "POST" },
            ).then(function (r) { return r.json(); });

            if (!started.rail_order_id) throw new Error(started.error || "could not start");

            var checkout = new Razorpay({
              key: ${JSON.stringify(keyId)},
              order_id: started.rail_order_id,
              customer_id: started.customer_id,
              recurring: "1",
              name: ${JSON.stringify(view.merchantName)},
              description: "Authorise autopay",
              handler: async function () {
                status.textContent = "Confirming with your bank...";
                var done = await fetch("/mandate/" + mandate + "/instrument/complete", {
                  method: "POST",
                }).then(function (r) { return r.json(); });
                if (done.attached) {
                  window.location.href = "/mandate/" + mandate + "/instrument/done";
                } else {
                  status.textContent = done.error || "Your bank has not confirmed it yet.";
                  button.disabled = false;
                  cardButton.disabled = false;
                }
              },
              modal: {
                ondismiss: function () {
                  button.disabled = false;
                  cardButton.disabled = false;
                  status.textContent = "";
                },
              },
            });
            checkout.open();
          } catch (error) {
            status.textContent = String(error.message || error);
            button.disabled = false;
            cardButton.disabled = false;
          }
        }

        button.addEventListener("click", function () { begin("upi"); });
        cardButton.addEventListener("click", function () { begin("card"); });
      })();
    </script>`;
  return page("Add a way to pay", body);
}

export interface PayView {
  readonly intentId: string;
  readonly merchantName: string;
  readonly amountPaise: Paise;
  readonly railOrderId: string;
}

/**
 * Paying for an order an agent asked for.
 *
 * The agent created the intent; the kernel authorised it; the executor made a real order
 * at the rail. What is missing is the money, and a person supplies it here. Everything
 * rendered comes from the order row — the agent cannot influence a figure on this page.
 *
 * Nothing here trusts the browser afterwards either: the payment is confirmed by the
 * webhook the rail sends us, which is checked against provider truth before a single
 * reservation moves.
 */
export function payPage(view: PayView, keyId: string): string {
  const body = `
    <h1>Approve ${rupees(view.amountPaise)}?</h1>
    <p class="sub">at ${escape(view.merchantName)}, for an order your assistant placed</p>

    <div class="card">
      <div class="row"><span class="k">Amount</span>
        <span class="v">${rupees(view.amountPaise)}</span></div>
      <div class="row"><span class="k">Merchant</span>
        <span class="v">${escape(view.merchantName)}</span></div>
      <div class="row"><span class="k">Rail order</span>
        <span class="v">${escape(view.railOrderId)}</span></div>
    </div>

    <button id="pay" type="button">Pay ${rupees(view.amountPaise)}</button>
    <p class="note" id="status">Every figure here is the merchant's own price, taken from
    the order. The assistant never supplied one.</p>

    <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
    <script>
      document.getElementById("pay").addEventListener("click", function () {
        var button = this;
        var status = document.getElementById("status");
        button.disabled = true;
        new Razorpay({
          key: ${JSON.stringify(keyId)},
          order_id: ${JSON.stringify(view.railOrderId)},
          name: ${JSON.stringify(view.merchantName)},
          description: "Order placed by your assistant",
          handler: function () {
            status.textContent =
              "Paid. The kernel is confirming it with the rail before anything is recorded.";
          },
          modal: { ondismiss: function () { button.disabled = false; } },
        }).open();
      });
    </script>`;
  return page("Approve payment", body);
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
