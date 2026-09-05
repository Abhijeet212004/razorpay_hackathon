import type { TraceEntry } from "../console/console.repository.js";
import { escape, shell, type ShellOptions } from "./dashboard.shell.js";

/**
 * One decision, in full.
 *
 * The overview answers "what happened". This answers "why", and it can, because every
 * decision writes the rules it evaluated to the ledger alongside the verdict. Nothing here
 * is reconstructed after the fact: the observed value and the bound it was checked against
 * are exactly what the kernel saw at the moment it decided.
 */

interface RuleEvaluation {
  rule: string;
  passed: boolean;
  observed: string | null;
  bound: string | null;
  reason_code: string | null;
}

interface DecisionPayload {
  verdict?: string;
  reason_code?: string;
  evaluated?: RuleEvaluation[];
}

const RULE_NAMES: Record<string, string> = {
  "stateless": "Signature, freshness and quote",
  "agent.registered": "Agent is known to us",
  "verifier.availability": "Second opinion was reachable",
  "verifier.objection": "Second opinion raised no objection",
  "taint.decisionField": "No untrusted text in a decision field",
  "mandate.authEvent": "Permission traces to a real approval",
  "mandate.bindsAgent": "Permission belongs to this agent",
  "mandate.notRevoked": "Permission not revoked",
  "mandate.validity": "Permission still in date",
  "scope.merchant": "Merchant is in scope",
  "scope.category": "Category is in scope",
  "intent.nonceUnspent": "Request has not been used before",
  "quote.unconsumed": "Price has not been spent",
  "quote.notExpired": "Price is still current",
  "limits.perTransaction": "Within the per order limit",
  "limits.cumulative": "Within the window cap",
  "limits.velocity": "Within the purchase rate",
  "stepUp.silentThreshold": "Below the amount that needs asking",
  "stepUp.firstAtMerchant": "Not the first purchase here",
};

const KIND_LABEL: Record<string, string> = {
  INTENT: "Agent proposed a purchase",
  DECISION: "Kernel decided",
  RESERVATION: "Budget held",
  API_CALL: "Sent to the payment rail",
  WEBHOOK: "Rail reported back",
  EXECUTION_RESULT: "Payment settled",
  RELEASE: "Budget released",
  RECONCILE: "Resolved by reading the rail",
  REFUND: "Refunded",
  MANDATE_ISSUED: "Permission granted",
  ANCHOR: "Chain anchored",
};

function rupees(paise: string | null | undefined): string {
  if (paise === null || paise === undefined) return "–";
  const whole = paise.length > 2 ? paise.slice(0, -2) : "0";
  return `₹${Number(whole).toLocaleString("en-IN")}`;
}

/** The merchant's own clock, not the container's. Servers run UTC; shopkeepers do not. */
const DISPLAY_TIME_ZONE = process.env.DISPLAY_TIME_ZONE ?? "Asia/Kolkata";

function stamp(date: Date): string {
  return date.toLocaleString("en-IN", {
    timeZone: DISPLAY_TIME_ZONE,
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

/**
 * An intent can be decided more than once: a step up asks a human, and their approval is a
 * second decision. The outcome is the last one, but the rule evaluation lives on the
 * decision that actually ran the checks, so the two are read separately rather than
 * showing an approval as though nothing was examined.
 */
function verdictOf(entries: readonly TraceEntry[]): DecisionPayload {
  const decisions = entries
    .filter((e) => e.kind === "DECISION")
    .map((e) => (e.payload ?? {}) as DecisionPayload);
  if (decisions.length === 0) return {};

  const outcome = decisions[decisions.length - 1]!;
  const examined = [...decisions].reverse().find((d) => (d.evaluated?.length ?? 0) > 0);
  const evaluated = examined?.evaluated ?? outcome.evaluated;
  return evaluated === undefined ? outcome : { ...outcome, evaluated };
}

/** How many times this intent was decided, so a step up reads as the two events it was. */
function decisionCount(entries: readonly TraceEntry[]): number {
  return entries.filter((e) => e.kind === "DECISION").length;
}

function verdictWord(verdict: string | undefined): { cls: string; word: string } {
  if (verdict === "ALLOW") return { cls: "allow", word: "Approved" };
  if (verdict === "STEP_UP") return { cls: "stepup", word: "Asked a human" };
  return { cls: "deny", word: "Refused" };
}

/** The one rule that decided it, so a reader is not left comparing eighteen rows. */
function decidingRule(evaluated: readonly RuleEvaluation[]): RuleEvaluation | undefined {
  return evaluated.find((r) => !r.passed);
}

function ruleRows(evaluated: readonly RuleEvaluation[]): string {
  return evaluated
    .map((r) => {
      const label = RULE_NAMES[r.rule] ?? r.rule;
      const mark = r.passed
        ? `<span class="v allow">Passed</span>`
        : `<span class="v ${r.rule.startsWith("stepUp.") ? "stepup" : "deny"}">${r.rule.startsWith("stepUp.") ? "Asked a person" : "Refused here"}</span>`;
      const compare =
        r.observed === null && r.bound === null
          ? "–"
          : `<span class="mono" style="font-size:11.5px">${escape(String(r.observed ?? "–"))}</span>` +
            (r.bound === null
              ? ""
              : ` <span style="color:var(--ink-3)">against</span> <span class="mono" style="font-size:11.5px">${escape(r.bound)}</span>`);
      return `<tr${r.passed ? "" : ' style="background:var(--sink)"'}>
        <td>${escape(label)}<div class="mono" style="font-size:10.5px;color:var(--ink-3);margin-top:2px">${escape(r.rule)}</div></td>
        <td>${mark}</td>
        <td>${compare}</td>
        <td class="id">${escape(r.reason_code ?? "")}</td>
      </tr>`;
    })
    .join("");
}

function timelineRows(entries: readonly TraceEntry[]): string {
  return entries
    .map((e) => {
      const label = KIND_LABEL[e.kind] ?? e.kind;
      const detail = e.payload === null || e.payload === undefined
        ? ""
        : `<pre class="code" style="margin:8px 0 0;font-size:11.5px">${escape(
            JSON.stringify(e.payload, null, 2),
          )}</pre>`;
      return `<li>
        <div class="tl-mark"></div>
        <div class="tl-body">
          <div class="tl-head">
            <span class="tl-what">${escape(label)}</span>
            <span class="tl-when">${escape(stamp(e.createdAt))}</span>
          </div>
          <div class="tl-meta">ledger entry <span class="mono">#${e.seq}</span>
            <span style="color:var(--ink-3)">· ${escape(e.kind)}</span></div>
          ${detail}
        </div>
      </li>`;
    })
    .join("");
}

const TIMELINE_CSS = `
<style>
.tl{list-style:none;margin:0;padding:0;position:relative}
.tl::before{content:"";position:absolute;left:7px;top:10px;bottom:10px;width:1px;background:var(--line)}
.tl li{display:grid;grid-template-columns:16px minmax(0,1fr);gap:14px;padding:0 0 20px}
.tl li:last-child{padding-bottom:0}
.tl-mark{width:7px;height:7px;border-radius:50%;background:var(--ink-3);
  margin-top:7px;margin-left:4px;position:relative;z-index:1}
.tl-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
.tl-what{font-weight:700;font-size:14.5px;color:var(--ink)}
.tl-when{font-size:12.5px;color:var(--ink-3);font-variant-numeric:tabular-nums;font-weight:500}
.tl-meta{font-size:12.5px;color:var(--ink-3);margin-top:2px;font-weight:500}
.kv{display:grid;grid-template-columns:auto 1fr;gap:6px 20px;font-size:14px;font-weight:500}
.kv dt{color:var(--ink-3)}
.kv dd{margin:0;font-weight:600}
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:0;
  border:1px solid var(--line);border-radius:6px;overflow:hidden;background:var(--panel);margin-bottom:18px}
.summary > div{padding:14px 16px;border-right:1px solid var(--line-2)}
.summary > div:last-child{border-right:0}
.summary .k{font-size:12px;color:var(--ink-3);font-weight:600;margin-bottom:5px}
.summary .val{font-size:17px;font-weight:700;letter-spacing:-.01em}
</style>`;

export function decisionPage(
  opts: ShellOptions,
  intentId: string,
  entries: readonly TraceEntry[],
): string {
  if (entries.length === 0) {
    return shell(opts, `
      <div class="head"><h1>Decision not found</h1>
      <p>No ledger entry references <code>${escape(intentId)}</code>.</p></div>
      <a class="btn ghost" href="/dashboard/activity">Back to activity</a>`);
  }

  const decision = verdictOf(entries);
  const evaluated = decision.evaluated ?? [];
  const { cls, word } = verdictWord(decision.verdict);
  const stopped = decidingRule(evaluated);
  const intent = entries.find((e) => e.kind === "INTENT")?.payload as
    | { amount_paise?: string }
    | undefined;
  const passedCount = evaluated.filter((r) => r.passed).length;

  return shell(opts, `${TIMELINE_CSS}
    <div class="head">
      <a href="/dashboard/activity" style="font-size:12.5px">Agent activity</a>
      <h1 style="margin-top:6px">Decision</h1>
      <p class="mono" style="font-size:12.5px">${escape(intentId)}</p>
      <p style="margin-top:10px"><a class="btn ghost"
        href="/dashboard/activity/${encodeURIComponent(intentId)}/chain">Verify the chain</a></p>
    </div>

    <div class="summary">
      <div><div class="k">Outcome</div><div class="val"><span class="v ${cls}">${escape(word)}</span></div></div>
      <div><div class="k">Amount</div><div class="val">${rupees(intent?.amount_paise)}</div></div>
      <div><div class="k">Reason</div><div class="val mono" style="font-size:13px">${escape(decision.reason_code ?? "–")}</div></div>
      <div><div class="k">Checks run</div><div class="val">${passedCount} of ${evaluated.length} passed</div></div>
      <div><div class="k">Ledger entries</div><div class="val">${entries.length}</div></div>
      ${decisionCount(entries) < 2 ? "" : `<div><div class="k">Decided</div>
        <div class="val">${decisionCount(entries)} times</div></div>`}
    </div>

    ${decisionCount(entries) < 2 ? "" : `
    <div class="notice">
      <strong>This was decided twice.</strong> The checks below produced a step up, which
      is not a refusal: it asks a person. Their approval is the second decision, and it is
      what let the purchase proceed.
    </div>`}

    ${stopped === undefined ? "" : `
    <div class="notice warn">
      <strong>${escape(RULE_NAMES[stopped.rule] ?? stopped.rule)}</strong> is the rule that
      ${stopped.rule.startsWith("stepUp.") ? "sent this to a person" : "refused this"}.
      ${
        stopped.bound === null
          ? `It observed <code>${escape(String(stopped.observed ?? "–"))}</code>.`
          : `It saw <code>${escape(String(stopped.observed ?? "–"))}</code> where the
             permission allows <code>${escape(stopped.bound)}</code>.`
      }
      Every rule before it passed, and nothing after it was evaluated.
    </div>`}

    <div class="panel">
      <header><div><h2>What was checked</h2>
        <p>In order. The first rule to fail decides the outcome, and the rest are not evaluated.</p></div></header>
      <div class="body flush">
        ${evaluated.length === 0
          ? `<div class="empty">This decision recorded no rule evaluation.</div>`
          : `<div class="tablewrap"><table>
              <thead><tr><th>Rule</th><th>Result</th><th>What it saw</th><th>Code</th></tr></thead>
              <tbody>${ruleRows(evaluated)}</tbody></table></div>`}
      </div>
    </div>

    <div class="panel">
      <header><div><h2>Timeline</h2>
        <p>Every entry written to this permission's hash chain, in the order it happened.</p></div></header>
      <div class="body">
        <ul class="tl">${timelineRows(entries)}</ul>
      </div>
    </div>`);
}
