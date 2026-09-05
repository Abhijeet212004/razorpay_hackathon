/**
 * Regenerates the two large plates in docs/plates/.
 *
 *   node scripts/plates.mjs
 *
 * Everything is laid out by cursor, so adding a row or a box shifts what follows and the
 * viewBox grows to fit. Nothing here is hand-positioned, which is why these can be edited
 * a year from now without redrawing them.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.PLATES_OUT ?? resolve(ROOT, "docs/plates");

const C = {
  ink: "#0F141C",
  muted: "#5C6A7D",
  faint: "#8492A6",
  blue: "#1240D8",
  red: "#A5211A",
  green: "#0B6B4F",
  amber: "#8A5A00",
  violet: "#5B2E9D",
  warm: "#F7F5F1",
  cool: "#F4F6FA",
  mint: "#F1F7F4",
  line: "#DCE2EB",
  box: "#B7C1D0",
  white: "#FFFFFF",
};

const MONO = "'IBM Plex Mono', ui-monospace, Menlo, 'Courier New', monospace";
const SANS = "Archivo, 'Helvetica Neue', Arial, sans-serif";

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const r = (n) => Math.round(n * 10) / 10;

/* ------------------------------------------------------------------ primitives */

function Doc(width, title, aria) {
  const parts = [];
  return {
    width,
    title,
    aria,
    y: 0,
    parts,
    raw(s) {
      parts.push(s);
    },
    text(x, y, s, o = {}) {
      const {
        size = 9.3,
        fill = C.muted,
        anchor = "start",
        weight = 400,
        font = MONO,
        ls = 0,
      } = o;
      parts.push(
        `<text x="${r(x)}" y="${r(y)}" font-family="${font}" font-size="${size}" fill="${fill}" text-anchor="${anchor}" font-weight="${weight}" letter-spacing="${ls}" xml:space="preserve">${esc(s)}</text>`,
      );
    },
    rect(x, y, w, h, o = {}) {
      const { fill = "none", stroke = C.line, sw = 1, rx = 2, dash = null } = o;
      parts.push(
        `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`,
      );
    },
    line(x1, y1, x2, y2, o = {}) {
      const { stroke = C.line, sw = 1, dash = null, marker = null } = o;
      parts.push(
        `<line x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}" stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ""}${marker ? ` marker-end="url(#${marker})"` : ""}/>`,
      );
    },
    path(d, o = {}) {
      const { stroke = C.ink, sw = 1, fill = "none", dash = null, marker = null } = o;
      parts.push(
        `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ""}${marker ? ` marker-end="url(#${marker})"` : ""}/>`,
      );
    },
    render(height) {
      const markers = ["ink", "blue", "red", "green", "amber", "violet"]
        .map(
          (k) =>
            `<marker id="ar_${k}" viewBox="0 0 10 10" refX="9.4" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0.6 L10,5 L0,9.4 z" fill="${C[k]}"/></marker>`,
        )
        .join("");
      return `<svg viewBox="0 0 ${width} ${Math.ceil(height)}" role="img" aria-label="${esc(aria)}" xmlns="http://www.w3.org/2000/svg" style="max-width:100%;height:auto;display:block"><defs>${markers}</defs><rect x="0" y="0" width="${width}" height="${Math.ceil(height)}" fill="${C.white}"/>${parts.join("")}</svg>`;
    },
  };
}

const MARKER = { ink: "ar_ink", blue: "ar_blue", red: "ar_red", green: "ar_green", amber: "ar_amber", violet: "ar_violet" };

/* ============================================================ FIGURE A · ARCHITECTURE */

function architecture() {
  const W = 1680;
  const M = 60;
  const IW = W - M * 2;
  const d = Doc(
    W,
    "architecture",
    "Complete system architecture of AgentKit for Razorpay: untrusted client surfaces, the trust boundary, the Razorpay-side agent commerce directory where agents discover which merchants exist and what they sell, the per-merchant HTTP edge, the deterministic trust kernel, the credential-holding executor, the background worker, the PostgreSQL data layer under row level security, and the external payment rails.",
  );

  let y = 26;
  d.text(M, y, "PLATE A · SYSTEM ARCHITECTURE, COMPLETE", {
    size: 11,
    fill: C.ink,
    weight: 600,
    ls: 1.3,
  });
  d.text(W - M, y, "AGENTKIT FOR RAZORPAY · AGENTIC COMMERCE TRUST LAYER", {
    size: 9.5,
    fill: C.faint,
    anchor: "end",
    weight: 600,
    ls: 1.3,
  });
  y += 10;
  d.line(M, y, W - M, y, { stroke: C.ink, sw: 1.4 });
  y += 22;

  d.text(M, y, "The trust boundary sits below the model, not around it.", {
    size: 13,
    fill: C.ink,
    font: SANS,
    weight: 600,
  });
  y += 17;
  d.text(
    M,
    y,
    "A fully compromised agent gets one transaction, at an allowlisted merchant, under the silent threshold, fully logged and reversible — not because the model was defended, but because it was never trusted.",
    { size: 9.6, fill: C.muted },
  );
  y += 26;

  /* --- panel helper --- */
  function panel(label, note, body, opts = {}) {
    const { fill = C.cool, accent = C.line } = opts;
    const top = y;
    y += 21;
    d.text(M + 14, y, label, { size: 9.5, fill: opts.labelFill ?? C.muted, weight: 600, ls: 1.3 });
    if (note)
      d.text(W - M - 14, y, note, {
        size: 8.8,
        fill: C.faint,
        anchor: "end",
        weight: 600,
        ls: 1.3,
      });
    y += 13;
    body();
    y += 14;
    // panel rect drawn behind: unshift
    const h = y - top;
    d.parts.unshift(
      `<rect x="${M}" y="${r(top)}" width="${IW}" height="${r(h)}" rx="2" fill="${fill}" stroke="${accent}" stroke-width="1"/>`,
    );
    y += 16;
    return h;
  }

  /* --- box helper: returns height --- */
  function box(x, yy, w, o) {
    const { title, tag, tagColor = C.blue, lines = [], stroke = C.box, fill = C.white, titleSize = 12 } = o;
    const h = 16 + (title ? 18 : 0) + lines.length * 12.6 + 10;
    d.rect(x, yy, w, h, { fill, stroke });
    let ty = yy + 20;
    if (title) {
      d.text(x + 11, ty, title, { size: titleSize, fill: C.ink, font: SANS, weight: 600 });
      if (tag)
        d.text(x + w - 11, ty, tag, {
          size: 8.4,
          fill: tagColor,
          anchor: "end",
          weight: 600,
          ls: 1.2,
        });
      ty += 17;
    }
    for (const l of lines) {
      const [txt, col] = Array.isArray(l) ? l : [l, C.muted];
      d.text(x + 11, ty, txt, { size: 9.2, fill: col });
      ty += 12.6;
    }
    return h;
  }

  function row(boxes, gap = 14) {
    const n = boxes.length;
    const w = (IW - 28 - gap * (n - 1)) / n;
    let maxH = 0;
    boxes.forEach((b, i) => {
      const h = box(M + 14 + i * (w + gap), y, w, b);
      maxH = Math.max(maxH, h);
    });
    // normalise heights by redrawing borders is overkill; just advance
    y += maxH + gap;
    return maxH;
  }

  function down(label, color = C.blue) {
    d.text(M + 14, y + 2, `▼  ${label}`, { size: 10, fill: color, weight: 600 });
    y += 16;
  }

  /* ---------------- LAYER 0 ---------------- */
  panel(
    "LAYER 0 · CLIENT SURFACES — UNTRUSTED. EVERY BYTE FROM HERE IS INPUT, NEVER INSTRUCTION",
    "NOTHING HERE HOLDS A PAYMENT CREDENTIAL",
    () => {
      row([
        {
          title: "Third-party buyer agent",
          tag: "UNTRUSTED",
          tagColor: C.red,
          stroke: C.red,
          lines: [
            "MCP client · hand-written tool loop, no framework",
            "plan frozen → SHA-256 before any catalog byte is read",
            "Ed25519 keystore · agent_id, kid, self-registered",
            "separate process, separate env, no Razorpay secret",
          ],
        },
        {
          title: "Merchant's own assistant",
          lines: [
            "same POST /agent/mcp endpoint, same gate",
            "no shortcut for being first-party",
            "which tool classes it sees is the merchant's choice",
            "read · propose · money — money can be withheld whole",
          ],
        },
        {
          title: "Non-MCP buyer",
          lines: [
            "POST /agent/acp/checkout — ACP-shaped REST",
            "identical authorisation path, different transport",
            "the transport changed, the gate did not",
            "for buyers that speak no MCP at all",
          ],
        },
        {
          title: "Shopper's browser",
          tag: "HUMAN",
          tagColor: C.green,
          stroke: C.green,
          lines: [
            "/consent/:ref · /agent/approve/:challenge · /pay/:id",
            "server-rendered from server-held state only",
            "amount and basket come from the signed quote",
            "nothing the agent supplied is ever displayed",
          ],
        },
      ]);
    },
    { fill: C.warm },
  );

  /* ---------------- TRUST BOUNDARY ---------------- */
  y -= 6;
  d.rect(M, y, IW, 46, { fill: "#FDF3F2", stroke: C.red, sw: 1.4 });
  d.text(M + 16, y + 20, "═══  TRUST BOUNDARY  ═══", { size: 10, fill: C.red, weight: 600, ls: 1.3 });
  d.text(
    M + 210,
    y + 20,
    "nothing above this line names a merchant, sets a price, widens a limit, or reaches a decision-bearing field",
    { size: 9.6, fill: C.ink },
  );
  d.text(
    M + 16,
    y + 36,
    "INV-01 no model output is ever executed  ·  INV-12 untrusted content is never instruction  ·  the compiler rejects Tainted<T> in amount_paise and merchant_id",
    { size: 9, fill: C.red },
  );
  y += 46 + 20;

  /* ---------------- LAYER 1 · DIRECTORY ---------------- */
  panel(
    "LAYER 1 · AGENT COMMERCE DIRECTORY — RAZORPAY-SIDE · HOW AN AGENT LEARNS WHICH MERCHANTS EXIST AND WHAT EACH ONE SELLS",
    "READ-ONLY · CREDENTIAL-FREE · SIGNED · GRANTS NOTHING",
    () => {
      d.text(
        M + 14,
        y,
        "An agent that cannot find a merchant cannot buy from one. Discovery is therefore a first-class plane, run by Razorpay across every merchant on the kernel — and it is deliberately",
        { size: 9.4, fill: C.ink },
      );
      y += 13;
      d.text(
        M + 14,
        y,
        "the one plane that can never spend: it answers who exists, what they sell, and what they will let an agent do. Which merchant a money call binds to still comes from a key, never from here.",
        { size: 9.4, fill: C.ink },
      );
      y += 16;

      row([
        {
          title: "directory_merchants",
          tag: "INDEX",
          tagColor: C.green,
          stroke: C.green,
          lines: [
            "merchant_id · display_name · legal_name · logo",
            "categories[] · pincode / delivery zones",
            "fulfilment SLA · min & max order value",
            "currency · transports[] (mcp, acp)",
            "manifest_url · catalog_feed_url · kid",
            "state: active | suspended  (suspended never lists)",
          ],
        },
        {
          title: "merchant_capabilities",
          tag: "WHAT AN AGENT MAY DO",
          tagColor: C.green,
          stroke: C.green,
          lines: [
            "tool classes exposed: read | propose | money",
            "mandate shape the merchant accepts",
            "limit envelope offered (per-txn, cumulative, window)",
            "silent threshold the merchant will honour",
            "step_up policy · refunds_enabled · cancel window",
            "categories that are agent-purchasable at all",
          ],
        },
        {
          title: "directory_catalog_index",
          tag: "PUBLIC FACTS ONLY",
          tagColor: C.green,
          stroke: C.green,
          lines: [
            "merchant_id · sku · name · category · brand",
            "price_paise · price band · in_stock · updated_at",
            "no ledger, no orders, no mandates, no PII",
            "the ONE deliberately cross-tenant table —",
            "it holds nothing row level security exists to hide",
            "every string taint()-branded at ingest",
          ],
        },
      ]);

      row([
        {
          title: "directory_health & trust",
          lines: [
            "manifest reachable · catalog freshness (age)",
            "p95 authorise latency · capture rate",
            "dispute rate · quarantine count · uptime",
            "trust_grade is derived and recomputed hourly —",
            "never self-declared by the merchant",
            "stale feed → demoted, then hidden. never stale-served",
          ],
        },
        {
          title: "discovery API — no credential required",
          lines: [
            "GET /directory/search?category=&pincode=&max_price_paise=",
            "GET /directory/merchants/:merchant_id",
            "GET /directory/merchants/:merchant_id/capabilities",
            "GET /directory/catalog/search?q=&category=&merchants=",
            "GET /m/:merchant_id/.well-known/agent-commerce.json",
            "browsing is free precisely because buying is not",
          ],
        },
        {
          title: "signing & verification",
          lines: [
            "every response JCS (RFC 8785) → Ed25519, with kid",
            "agent verifies against Razorpay's published JWKS",
            "a listing an attacker rewrote fails the check",
            "the merchant's own feed is verified against THEIR kid",
            "before a single row of it is indexed",
            "ranking inputs are signed; the ranking is not",
          ],
        },
      ]);

      row([
        {
          title: "directory-sync · a worker job, not a request path",
          lines: [
            "crawls each merchant's manifest and signed catalog feed on a schedule",
            "verifies the merchant's kid before trusting a single row of it",
            "runs the SAME injection scan catalog-sync runs — SYSTEM:, ignore all limits,",
            "  override the cap, you are now — quarantined items are never indexed and never returned",
            "the merchant is told what was quarantined. the buyer never is:",
            "  a control that nags is a control that gets turned off",
            "writes directory_merchants, merchant_capabilities, directory_catalog_index, directory_health",
          ],
        },
        {
          title: "what discovery is NOT",
          tag: "RULES",
          tagColor: C.red,
          stroke: C.red,
          lines: [
            ["DIR-01  read-only. no directory route can move, reserve or promise money", C.ink],
            ["DIR-02  a directory answer NEVER names the tenant for a money call — the merchant", C.ink],
            ["        is still resolved from sha256(api key) alone, on every single request", C.red],
            ["DIR-03  every directory string is Tainted<T> and cannot reach a decision field", C.ink],
            ["DIR-04  quarantined listing text is never indexed, never ranked, never returned", C.ink],
            ["DIR-05  discovery grants nothing. a mandate is still per shopper, per merchant", C.ink],
            ["DIR-06  the index holds public catalog facts only — never another merchant's ledger", C.ink],
          ],
        },
      ]);
    },
    { fill: C.mint, accent: C.green, labelFill: C.green },
  );

  down(
    "the agent now knows WHO to talk to. from this point on it presents a key, and that key — not its choice — decides whose limits bind it",
    C.green,
  );
  y += 6;

  /* ---------------- LAYER 2 · EDGE ---------------- */
  panel(
    "LAYER 2 · HTTP EDGE — PER MERCHANT · MOUNTED BY guard.mount(app, \"/agent\") OR AN NGINX ROUTE TO THE SIDECAR",
    "THIS IS THE ENTIRE INTEGRATION SURFACE",
    () => {
      row([
        {
          title: "routes",
          lines: [
            "GET   /.well-known/agent-commerce.json     discovery manifest",
            "GET   /m/:merchant_id/.well-known/...      hosted merchants",
            "GET   /agent/catalog.json                  signed feed, JCS + Ed25519 + kid",
            "POST  /agent/register                      agent identity, self_registered_v1",
            "POST  /agent/mcp                           MCP transport, 10 declared tools",
            "POST  /agent/acp/checkout                  ACP-shaped REST for non-MCP buyers",
            "POST  /agent/webhooks/razorpay             HMAC-SHA256, event-id deduplicated",
            "GET   /agent/audit/:intent_id              replayable trace, payloads redacted",
            "GET   /agent/approve/:challenge            step-up, server state only",
            "GET   /consent/:ref  POST /consent/:ref/verify   the grant, with OTP",
            "GET   /pay/:intent_id                      shopper-present fallback",
          ],
        },
        {
          title: "middleware, in order — a handler cannot skip any of it",
          lines: [
            "1  TENANT  sha256(bearer key) → resolve_merchant_by_key() → merchant_id",
            "           SECURITY DEFINER, search_path pinned to pg_catalog, public",
            "           the id flows straight into the row level security context",
            "           there is NO field, header or body key that names a merchant",
            "2  LIMIT   token bucket · 30/min per agent · 10/min per mandate → LMT-005",
            "3  VALID   Zod at every boundary; the runtime validator and the TypeScript",
            "           type come from one definition, so they cannot drift apart",
            "4  TAINT   taint() wraps every outside string before a model can see it",
            "5  GATE    guard.requireMandate() answers DENY / STEP_UP having ALREADY",
            "           written the ledger entry — so a handler cannot forget to log a denial",
            "browsers resolve their tenant from the reference instead: a consent ref, a challenge",
            "id, an intent id are random UUIDs belonging to exactly one merchant — the receipt model",
          ],
        },
      ]);
    },
  );

  down("Zod-validated, rate-limited, tainted, tenant-scoped", C.blue);
  y += 6;

  /* ---------------- LAYER 3 · KERNEL ---------------- */
  panel(
    "LAYER 3 · TRUST KERNEL — DETERMINISTIC. NO MODEL RUNS HERE, AND NOTHING A MODEL PRODUCED REACHES A RULE",
    "SAME CODE PATH FOR MCP AND ACP",
    () => {
      const mods = [
        ["identity", ["OTP adapter · agent registry", "signing_keys, every signature", "carries a kid · INV-16"]],
        ["mandate", ["JWS/VC issue · scope · revoke", "revoke takes the SAME row lock", "authorisation takes · INV-09"]],
        ["quote", ["server-side pricing only", "binds mandate_id + basket_hash", "short TTL, single use · INV-14"]],
        ["policy", ["YAML → typed predicate union", "a pure fold: no I/O, no query,", "first failure wins · INV-08"]],
        ["verifier", ["blind, heuristic, memoised", "runs OUTSIDE the transaction", "may only ALLOW→DENY · INV-17"]],
        ["ledger", ["JCS → SHA-256, chain per mandate", "append-only because the GRANTS", "say so, not the code · INV-11"]],
        ["reconciler", ["HMAC → dedupe → orders.fetch", "resolves ambiguity by READING,", "never by retrying · INV-07"]],
        ["executor client", ["expresses what should happen", "without being able to do it", "HTTP to a portless service"]],
        ["orders", ["AUTHORISED → SUBMITTED →", "CAPTURED | FAILED | AMBIGUOUS", "no edge back to SUBMITTED"]],
        ["catalog", ["priced from the merchant's feed", "agent supplies skus and counts,", "never a price or a category"]],
        ["consent", ["the two human pages", "binds a FRESH auth_event", "max_age PT5M · INV-13"]],
        ["merchant registry", ["resolve_merchant_by_key()", "keys stored as sha256 only", "id never from a request body"]],
      ];
      const cols = 4;
      const gap = 14;
      const w = (IW - 28 - gap * (cols - 1)) / cols;
      let rowH = 0;
      mods.forEach((m, i) => {
        const col = i % cols;
        if (col === 0 && i > 0) {
          y += rowH + gap;
          rowH = 0;
        }
        const h = box(M + 14 + col * (w + gap), y, w, {
          title: m[0],
          titleSize: 11.4,
          lines: m[1],
        });
        rowH = Math.max(rowH, h);
      });
      y += rowH + gap + 4;

      // the authorisation transaction callout
      const th = 232;
      d.rect(M + 14, y, IW - 28, th, { fill: C.white, stroke: C.blue, sw: 1.4 });
      d.text(M + 28, y + 22, "THE AUTHORISATION SEQUENCE — the one function that decides", {
        size: 12,
        fill: C.ink,
        font: SANS,
        weight: 600,
      });
      d.text(W - M - 28, y + 22, "src/modules/authorization/authorization.service.ts", {
        size: 8.8,
        fill: C.faint,
        anchor: "end",
      });
      const half = (IW - 28) / 2;
      const L = [
        ["  1", "stateless checks", "signature · nonce format · expiry · taint · quote signature", C.ink],
        ["", "", "quote.mandate_id == intent.mandate_id · amount == quote.amount", C.muted],
        ["  2", "blind verifier", "outside any transaction, downgrade-only, 1.5s budget", C.ink],
        ["", "", "UNAVAILABLE denies above the silent threshold, never falls through", C.muted],
        ["", "── BEGIN READ COMMITTED ──", "", C.blue],
        ["  3", "row lock", "SELECT … FROM mandates WHERE id = ? FOR UPDATE", C.ink],
        ["  4", "mandate", "live · unrevoked · binds this agent · category in scope", C.ink],
        ["  5", "nonce", "burn it — a replayed intent dies here", C.ink],
        ["  6", "CAP READ", "SUM over reservations in ('held','captured') in the window", C.ink],
        ["", "", "read from the database, never from the request · INV-05", C.red],
      ];
      const R = [
        ["  7", "caps", "per-transaction ₹5,000 · cumulative ₹15,000 / 30d · velocity", C.ink],
        ["  8", "step-up", "above the ₹500 silent threshold → STP-001, not a failure", C.ink],
        ["  9", "quote", "consume it — single use, and it named this mandate", C.ink],
        [" 10", "write", "INSERT reservation('held') + ledger INTENT, DECISION, RESERVATION", C.ink],
        ["", "── COMMIT ──", "the reservation is durable BEFORE money can move", C.blue],
        [" 11", "executor", "after commit, never during. reserve-then-pay over-counts, which is", C.ink],
        ["", "", "conservative and reaped; pay-then-reserve under-counts — a cap bypass", C.muted],
        ["", "why 1, 2 and 11 sit outside", "they touch no shared state, and a third-party call", C.green],
        ["", "", "must never run while a mandate row lock is held · INV-19", C.green],
        ["", "every outcome", "writes exactly ONE ledger entry, denials included · INV-10", C.red],
      ];
      let ly = y + 44;
      L.forEach(([n, k, v, col]) => {
        if (n) d.text(M + 28, ly, n, { size: 9.4, fill: C.blue, weight: 600 });
        if (k) d.text(M + 52, ly, k, { size: 9.4, fill: col, weight: 600 });
        d.text(M + 52 + 132, ly, v, { size: 9.2, fill: col === C.ink ? C.muted : col });
        ly += 17.2;
      });
      ly = y + 44;
      R.forEach(([n, k, v, col]) => {
        if (n) d.text(M + 28 + half, ly, n, { size: 9.4, fill: C.blue, weight: 600 });
        if (k) d.text(M + 52 + half, ly, k, { size: 9.4, fill: col, weight: 600 });
        d.text(M + 52 + half + 156, ly, v, { size: 9.2, fill: col === C.ink ? C.muted : col });
        ly += 17.2;
      });
      d.line(M + 14 + half, y + 32, M + 14 + half, y + th - 12, { stroke: C.line });
      y += th + 4;
    },
  );

  down("ALLOW, and only after COMMIT", C.green);
  y += 6;

  /* ---------------- LAYER 4 · EXECUTOR ---------------- */
  panel(
    "LAYER 4 · EXECUTOR — THE ONLY PROCESS ON THE SYSTEM THAT HOLDS A PAYMENT CREDENTIAL",
    "NO PUBLISHED PORT · NO MODEL ANYWHERE NEAR IT",
    () => {
      row([
        {
          title: "executor",
          tag: "INV-02",
          tagColor: C.red,
          stroke: C.red,
          lines: [
            "reachable only on the internal network, with a shared token",
            "kernel and worker call it; nothing else can reach it at all",
            "idempotency key = sha256(intent_id) on every money call · INV-04",
            "the same intent replayed collapses into one payment at the rail",
            "assertEgressPermitted() before every fetch — allowlist, not a proxy",
            "refuses to call out while a mandate row lock is held · INV-19",
          ],
        },
        {
          title: "the ordering that prevents a double charge",
          lines: [
            "the order row is written and COMMITTED before the outbound call",
            "SUBMITTING means \"a call may have been made\" — a timeout is not a no-op",
            "the reaper releases a hold only when no order row exists for the intent,",
            "so an order created earlier would make a crashed execution unreapable",
            "a timeout leaves a payment that may well exist; reaping it would",
            "under-count money that moved. so it does not reap. it reads.",
          ],
        },
        {
          title: "credential blast radius",
          tag: "R1",
          tagColor: C.amber,
          stroke: C.amber,
          lines: [
            "executor key compromise is UNBOUNDED. we do not claim otherwise.",
            "minimised to one process, allowlisted egress, no model near it —",
            "that is the entire mitigation, and it is named as a limit, not a control",
            "key custody is not production-grade: no HSM, no rehearsed rotation",
            "make creds proves the credential exists in exactly one process",
          ],
        },
      ]);
    },
    { fill: C.warm },
  );

  /* ---------------- LAYER 5 · WORKER ---------------- */
  panel(
    "LAYER 5 · WORKER — pg-boss ON THE SAME POSTGRES · EVERY NON-TERMINAL STATE HAS A JOB THAT RESOLVES IT",
    "NO CRON, NO EXTERNAL QUEUE, NO SECOND DATASTORE",
    () => {
      const jobs = [
        ["reconcile-ambiguous", ["orders.fetch with backoff", "resolves by reading, never", "by retrying · INV-07"]],
        ["compensate-revoked", ["a payment in flight when a", "mandate was revoked → refund", "a compensating entry, not an edit"]],
        ["release-stale-reservations", ["a hold with no order row is", "released and the cap returned", "ADR-003 · INV-20"]],
        ["expire-mandates", ["validity elapsed → expired", "before anything can be", "authorised against it"]],
        ["verify-chain + anchor", ["recompute every chain from", "raw rows, write ANCHOR", "a tamper is caught here"]],
        ["catalog-sync", ["pull the merchant's own product", "endpoint · injection scan →", "quarantine · this is the integration"]],
        ["directory-sync", ["crawl manifests and signed feeds", "verify each merchant's kid,", "then index · health & trust_grade"]],
      ];
      const cols = 4;
      const gap = 14;
      const w = (IW - 28 - gap * (cols - 1)) / cols;
      let rowH = 0;
      jobs.forEach((m, i) => {
        const col = i % cols;
        if (col === 0 && i > 0) {
          y += rowH + gap;
          rowH = 0;
        }
        const h = box(M + 14 + col * (w + gap), y, w, {
          title: m[0],
          titleSize: 11,
          lines: m[1],
          stroke: m[0] === "directory-sync" ? C.green : C.box,
        });
        rowH = Math.max(rowH, h);
      });
      y += rowH;
    },
  );

  /* ---------------- LAYER 6 · DATA ---------------- */
  panel(
    "LAYER 6 · DATA — ONE POSTGRES · ISOLATION IS THE DATABASE'S JOB, NOT THE APPLICATION'S",
    "RLS WITH FORCE · FIVE LEAST-PRIVILEGE ROLES",
    () => {
      row([
        {
          title: "roles",
          lines: [
            "agentkit_owner    owns every object · DDL only, never serves traffic",
            "agentkit_kernel   SELECT/INSERT · NO update or delete on ledger, ever",
            "agentkit_worker   the jobs · narrower than the kernel",
            "agentkit_console  read-only · what the audit UI connects as",
            "agentkit_admin    operator fleet view · cannot read a merchant's ledger",
            "bootstrap         migrations and seed, then it is done",
            "",
            "make verify runs as the read-only role, so it cannot repair",
            "anything it finds. a verifier that can write is not a verifier.",
          ],
        },
        {
          title: "tables",
          lines: [
            "mandates          the FOR UPDATE lock target, and the chain head",
            "ledger            append-only · UNIQUE (chain_id, prev_hash) · RLS FORCE",
            "ledger_anchor · reservations · quotes · orders · agents",
            "auth_events · signing_keys · consent_requests · challenges",
            "webhook_events    PK on provider_event_id — a duplicate is a PK violation",
            "pseudonym_map     mutable, and the erasure target · INV-18",
            "merchants · catalog_items · payment_instrument · audit_record",
            "mcp_sessions · dashboard_accounts · pgboss.*",
            "directory_merchants · merchant_capabilities · directory_catalog_index ·",
            "directory_health      ← the discovery plane. public facts, cross-tenant by design",
          ],
        },
        {
          title: "row level security",
          tag: "INV-21",
          tagColor: C.red,
          stroke: C.red,
          lines: [
            "ENABLE + FORCE on every tenant table, so even the owner is bound",
            "USING (merchant_id = current_setting('agentkit.merchant_id', true))",
            "the setting is written from the resolved key, once, per connection",
            "",
            "the ledger is append-only because there is no UPDATE or DELETE",
            "grant on it — not because the code declines to issue one",
            "",
            "the directory index is the single deliberate exception, and it is",
            "safe only because it holds nothing that RLS exists to protect:",
            "no ledger, no order, no mandate, no shopper, no amount spent",
          ],
        },
      ]);
    },
  );

  /* ---------------- LAYER 7 · EXTERNAL ---------------- */
  panel(
    "LAYER 7 · EXTERNAL — REACHABLE FROM THE EXECUTOR AND THE WORKER, AND FROM NOWHERE ELSE",
    "RAIL=replay IS THE DEFAULT AND NEEDS NO CREDENTIALS",
    () => {
      row([
        {
          title: "Razorpay API",
          lines: [
            "orders.create · payments.capture",
            "orders.fetch — re-read current truth",
            "refunds.create — the compensating path",
            "X-Razorpay-Idempotency-Key on every call",
            "intent_id travels in the order's notes field",
          ],
        },
        {
          title: "NPCI · UPI rail",
          tag: "NOT OURS",
          tagColor: C.amber,
          stroke: C.amber,
          lines: [
            "₹1,00,000 per-mandate ceiling",
            "₹15,000 above which the rail forces a PIN",
            "UPI Reserve Pay — PIN once, at enrolment,",
            "not once per purchase",
            "these bounds hold with or without us",
          ],
        },
        {
          title: "replay rail",
          lines: [
            "a recording, and the UI says so on every page",
            "same client code as the live rail — only the",
            "base URL and the credential differ",
            "posts its own webhooks back to the kernel",
            "INV-22 · no accounts, no keys, no signup",
          ],
        },
        {
          title: "merchant storefront",
          lines: [
            "the merchant's existing system — Express + Mongo here",
            "GET  /api/v1/products/all      → catalog_url",
            "POST /internal/agent/fulfil    → an agent purchase",
            "                                 becomes a real order",
            "no schema change, no migration, no shared database",
          ],
        },
      ]);
    },
    { fill: C.warm },
  );

  /* ---------------- BOUNDS + LEGEND ---------------- */
  panel(
    "THE BOUNDS ARE LAYERED, AND ONLY THE INNER ONES ARE OURS",
    "EVERY DEMO AMOUNT STAYS BELOW ₹15,000 SO NOTHING NPCI DOES IS MISTAKEN FOR SOMETHING WE DO",
    () => {
      const rows = [
        ["Rail ceiling", "NPCI / Razorpay", "₹1,00,000 per mandate", C.amber],
        ["Rail PIN threshold", "NPCI / Razorpay", "₹15,000 — above this the rail forces a PIN", C.amber],
        ["Policy per-transaction cap", "our mandate", "₹5,000", C.blue],
        ["Policy cumulative", "our mandate", "₹15,000 per 30 days", C.blue],
        ["Policy silent threshold", "our mandate", "₹500 — above this the shopper is asked, every time", C.red],
      ];
      let ry = y + 4;
      d.text(M + 28, ry, "BOUND", { size: 8.6, fill: C.faint, weight: 600, ls: 1.2 });
      d.text(M + 320, ry, "SET BY", { size: 8.6, fill: C.faint, weight: 600, ls: 1.2 });
      d.text(M + 480, ry, "VALUE", { size: 8.6, fill: C.faint, weight: 600, ls: 1.2 });
      d.text(M + 900, ry, "LEGEND", { size: 8.6, fill: C.faint, weight: 600, ls: 1.2 });
      ry += 8;
      d.line(M + 28, ry, M + 860, ry, { stroke: C.line });
      d.line(M + 900, ry, W - M - 28, ry, { stroke: C.line });
      ry += 16;
      const legend = [
        ["untrusted surface / refusal / the thing we cannot claim", C.red],
        ["a binding, a signature, or a decision the kernel makes", C.blue],
        ["evidence written, or the discovery plane", C.green],
        ["a bound set by someone other than us", C.amber],
        ["INV-nn · an invariant with one enforcement point and one test", C.ink],
        ["DIR-nn · a rule the discovery plane holds", C.ink],
      ];
      rows.forEach((rw, i) => {
        d.text(M + 28, ry, rw[0], { size: 9.6, fill: C.ink, weight: i >= 2 ? 600 : 400 });
        d.text(M + 320, ry, rw[1], { size: 9.4, fill: C.muted });
        d.text(M + 480, ry, rw[2], { size: 9.4, fill: rw[3], weight: 600 });
        if (legend[i]) {
          d.rect(M + 900, ry - 8, 10, 10, { fill: legend[i][1], stroke: legend[i][1] });
          d.text(M + 918, ry, legend[i][0], { size: 9.2, fill: C.muted });
        }
        ry += 18;
      });
      if (legend[5]) {
        d.rect(M + 900, ry - 8, 10, 10, { fill: legend[5][1], stroke: legend[5][1] });
        d.text(M + 918, ry, legend[5][0], { size: 9.2, fill: C.muted });
        ry += 18;
      }
      y = ry;
    },
  );

  y += 10;
  d.line(M, y, W - M, y, { stroke: C.ink, sw: 1.4 });
  y += 16;
  d.text(
    M,
    y,
    "23 invariants, each with one enforcement point, one test that goes red when that enforcement is deleted, and one place you can watch it hold.  make prove removes seven controls one at a time; seven tests go red.",
    { size: 9.2, fill: C.muted },
  );
  y += 24;

  return d.render(y);
}

/* ================================================================ FIGURE B · FLOW */

function flow() {
  const W = 1680;
  const M = 56;
  const d = Doc(
    W,
    "flow",
    "End-to-end flow of AgentKit for Razorpay across ten actors: merchant onboarding, an agent discovering merchants through the Razorpay-side directory, agent registration, the mandate grant with OTP and UPI Reserve Pay, the silent purchase path through the authorisation transaction, the step-up variant, settlement through a verified webhook, failure and repair, and the audit trail.",
  );

  const LANES = [
    ["SHOP", "Shopper", "a human being"],
    ["AGENT", "Buyer agent", "third-party, untrusted"],
    ["DIR", "Directory", "Razorpay-side · discovery"],
    ["EDGE", "HTTP edge", "guard / sidecar"],
    ["KERN", "Trust kernel", "deterministic"],
    ["EXEC", "Executor", "holds the credential"],
    ["WORK", "Worker", "pg-boss jobs"],
    ["DB", "PostgreSQL", "RLS FORCE"],
    ["RZP", "Razorpay / NPCI", "the rail"],
    ["STORE", "Merchant system", "their own stack"],
  ];

  const laneW = (W - M * 2) / LANES.length;
  const LX = {};
  LANES.forEach((l, i) => {
    LX[l[0]] = M + laneW * i + laneW / 2;
  });

  let y = 26;
  d.text(M, y, "PLATE B · END-TO-END FLOW, COMPLETE", { size: 11, fill: C.ink, weight: 600, ls: 1.3 });
  d.text(W - M, y, "ONBOARD → DISCOVER → REGISTER → GRANT → PURCHASE → SETTLE → REPAIR → AUDIT", {
    size: 9.5,
    fill: C.faint,
    anchor: "end",
    weight: 600,
    ls: 1.3,
  });
  y += 10;
  d.line(M, y, W - M, y, { stroke: C.ink, sw: 1.4 });
  y += 22;
  d.text(
    M,
    y,
    "Every numbered step below is one real call. Read it top to bottom and you have narrated the entire system: nothing here is elided, and nothing here is simulated.",
    { size: 9.6, fill: C.muted },
  );
  y += 24;

  // lane headers
  const headTop = y;
  LANES.forEach((l, i) => {
    const x = M + laneW * i;
    d.rect(x, y, laneW, 46, { fill: i % 2 ? C.cool : C.warm, stroke: C.line });
    d.text(x + laneW / 2, y + 20, l[1], { size: 11, fill: C.ink, font: SANS, weight: 600, anchor: "middle" });
    d.text(x + laneW / 2, y + 34, l[2], { size: 8.4, fill: C.faint, anchor: "middle" });
  });
  y += 46 + 10;
  const laneTop = y;

  const KIND = {
    plain: C.ink,
    bind: C.blue,
    ev: C.green,
    refuse: C.red,
    rail: C.amber,
  };

  const ROW = 25;
  let n = 0;

  function labelled(mx, ly, s, col) {
    const w = s.length * 5.22 + 10;
    // a long label on a short hop must not run off the plate
    const cx = Math.min(Math.max(mx, M + 4 + w / 2), W - M - 4 - w / 2);
    d.rect(cx - w / 2, ly - 10.5, w, 13.5, { fill: C.white, stroke: "none", rx: 1 });
    d.text(cx, ly, s, { size: 8.9, fill: col, anchor: "middle" });
  }

  function msg(from, to, label, kind = "plain") {
    n += 1;
    const col = KIND[kind];
    const marker = MARKER[kind === "plain" ? "ink" : kind === "bind" ? "blue" : kind === "ev" ? "green" : kind === "refuse" ? "red" : "amber"];
    const num = String(n).padStart(2, "0");
    const s = `${num}  ${label}`;
    if (from === to) {
      const x = LX[from];
      const w = s.length * 5.22 + 16;
      let x0 = x - 12;
      if (x0 + w > W - M - 4) x0 = W - M - 4 - w;
      if (x0 < M + 4) x0 = M + 4;
      d.path(`M ${r(x)} ${r(y - 9)} q -13 0 -13 9 q 0 9 13 9`, { stroke: col, sw: 1, dash: "2 2" });
      d.rect(x0, y - 9, w, 18, { fill: C.white, stroke: col, sw: 1, dash: "2 2" });
      d.text(x0 + 8, y + 3.5, s, { size: 8.9, fill: col });
    } else {
      const x1 = LX[from];
      const x2 = LX[to];
      const dir = x2 > x1 ? -1 : 1;
      d.line(x1 - dir * 2, y, x2 + dir * 5, y, { stroke: col, sw: 1.1, marker, dash: kind === "ev" ? "4 2" : null });
      labelled((x1 + x2) / 2, y - 5, s, col);
    }
    y += ROW;
  }

  function phase(label, note) {
    y += 10;
    d.rect(M, y, W - M * 2, 34, { fill: C.warm, stroke: C.box });
    d.text(M + 12, y + 15, label, { size: 9.6, fill: C.ink, weight: 600, ls: 1.3 });
    if (note) d.text(M + 12, y + 27, note, { size: 8.8, fill: C.muted });
    y += 34;
    // repeat the lane initials so a very tall figure stays readable anywhere in it
    d.rect(M, y, W - M * 2, 15, { fill: C.white, stroke: "none" });
    LANES.forEach((l, i) => {
      const lx = M + laneW * i + laneW / 2;
      d.rect(lx - 20, y + 1, 40, 13, { fill: C.white, stroke: "none" });
      d.text(lx, y + 11, l[0], { size: 7.6, fill: C.faint, anchor: "middle", weight: 600, ls: 0.8 });
    });
    y += 15 + 16;
  }

  /* ---- P0 ---- */
  phase("P0 · MERCHANT ONBOARDING — ONCE, AT INTEGRATION TIME", "no schema change, no migration, no shared database. the merchant points a URL at a route they already serve.");
  msg("STORE", "KERN", "POST /merchants/onboard { display_name, catalog_url, fulfil_url, public_base_url }", "plain");
  msg("KERN", "DB", "INSERT merchants — api_key and fulfil token minted here, and only sha256(key) is stored", "ev");
  msg("KERN", "STORE", "201 { api_key, fulfil_token } — shown once. a leaked table yields no working credential", "bind");
  msg("STORE", "STORE", "point catalog_url at the product endpoint you already serve", "plain");
  msg("STORE", "STORE", "publish /.well-known/agent-commerce.json → 302 to /m/:merchant_id/.well-known/…", "plain");
  msg("STORE", "STORE", "register the webhook URL in the Razorpay dashboard, paste the secret", "plain");
  msg("WORK", "STORE", "catalog-sync: GET catalog_url", "plain");
  msg("STORE", "WORK", "products — attacker-controlled text: a marketplace seller, a supplier feed, a compromised admin", "refuse");
  msg("WORK", "WORK", "injection scan → quarantine. the merchant is told; the buyer never is", "refuse");
  msg("WORK", "DB", "INSERT catalog_items — price and category come from the merchant, never from an agent", "ev");
  msg("WORK", "DIR", "directory-sync: fetch the manifest and the signed catalog feed, verify the merchant's own kid", "bind");
  msg("DIR", "DB", "INSERT directory_merchants + merchant_capabilities + directory_catalog_index", "ev");
  msg("DIR", "DIR", "health probe → trust_grade recomputed. a stale feed is demoted, then hidden — never stale-served", "ev");

  /* ---- P1 ---- */
  phase("P1 · DISCOVERY — THE AGENT HAS NEVER HEARD OF THIS MERCHANT", "the plane that answers who exists and what they sell. read-only, credential-free, signed — and it can never spend.");
  msg("SHOP", "AGENT", "\"order my usual groceries, under ₹600, delivered today\"", "plain");
  msg("AGENT", "AGENT", "freeze the plan → SHA-256, BEFORE a single external byte is read", "bind");
  msg("AGENT", "DIR", "GET /directory/search?category=grocery&pincode=411045&max_price_paise=60000", "plain");
  msg("DIR", "DB", "SELECT over directory_catalog_index + directory_merchants — public facts only", "plain");
  msg("DIR", "AGENT", "signed list: merchant_id, categories, delivery SLA, min order, trust_grade, transports[]", "bind");
  msg("AGENT", "AGENT", "verify JCS + Ed25519 against Razorpay's published JWKS, by kid. a rewritten listing fails here", "bind");
  msg("AGENT", "DIR", "GET /directory/merchants/mch_sharma_kirana/capabilities", "plain");
  msg("DIR", "AGENT", "tool classes read|propose|money · limit envelope offered · refunds off · cancel window 10m", "bind");
  msg("AGENT", "DIR", "GET /directory/catalog/search?q=atta&merchants=mch_sharma_kirana,mch_...", "plain");
  msg("DIR", "AGENT", "skus, names, categories, price bands, in_stock — every string Tainted<T> at the boundary", "refuse");
  msg("AGENT", "AGENT", "choose a merchant. this is the LAST moment the agent's choice matters", "refuse");
  msg("AGENT", "EDGE", "GET /m/mch_sharma_kirana/.well-known/agent-commerce.json — from the merchant's own origin", "plain");
  msg("EDGE", "AGENT", "manifest: transports, catalog url, mandate shape, grant_url, kid", "bind");

  /* ---- P2 ---- */
  phase("P2 · AGENT REGISTRATION — ONCE PER AGENT", "no partnership call, no key exchange, no allowlist to get onto. identity is free; authority is not.");
  msg("AGENT", "EDGE", "POST /agent/register { name, public_key: ed25519 }", "plain");
  msg("EDGE", "KERN", "forward — Zod-validated at the boundary, taint() applied to every outside string", "plain");
  msg("KERN", "DB", "INSERT agents (attestation = self_registered_v1)", "ev");
  msg("KERN", "AGENT", "201 { agent_id } — identity only. every money call still returns MND-001 until a mandate exists", "refuse");

  /* ---- P3 ---- */
  phase("P3 · THE MANDATE GRANT — ONCE PER AUTHORITY", "the only moment a human touches merchant property. from here on, the agent's authority is a row, not a promise.");
  msg("AGENT", "EDGE", "POST /consent/request { requested_scope } — key resolves the tenant, not the body", "plain");
  msg("EDGE", "AGENT", "202 { request_ref } — a reference, never a grant", "refuse");
  msg("AGENT", "SHOP", "show the consent URL taken from the SIGNED manifest, not one the model composed", "bind");
  msg("SHOP", "EDGE", "GET /consent/:request_ref — the tenant resolves from the reference, not a key", "plain");
  msg("EDGE", "KERN", "render from server-held state only. nothing the agent supplied appears on this page", "refuse");
  msg("KERN", "SHOP", "OTP dispatched to the registered number", "plain");
  msg("SHOP", "EDGE", "POST /consent/:ref/verify { otp }", "plain");
  msg("KERN", "DB", "INSERT auth_events { aev_…, max_age PT5M } — every mandate binds a FRESH auth · INV-13", "ev");
  msg("SHOP", "SHOP", "approve scope — narrow defaults. widening costs extra taps, on purpose", "bind");
  msg("SHOP", "RZP", "enrol UPI Reserve Pay — UPI PIN once, on the rail, not once per purchase", "rail");
  msg("KERN", "DB", "INSERT mandates (kid, auth_event, chain_id) + ledger seq 0 MANDATE_ISSUED, prev_hash = 32 zero bytes", "ev");
  msg("KERN", "AGENT", "200 { mandate_id } — opaque. the agent never holds signing material", "bind");

  /* ---- P4 ---- */
  phase("P4 · PURCHASE — THE SILENT PATH", "below the ₹500 silent threshold. no user interaction at all, and every step of it recomputable from raw rows afterwards.");
  msg("SHOP", "AGENT", "\"reorder my usual\"", "plain");
  msg("AGENT", "EDGE", "MCP catalog_search { query, mandate_id }", "plain");
  msg("EDGE", "KERN", "sha256(bearer key) → resolve_merchant_by_key() → merchant_id → RLS context on the connection", "bind");
  msg("KERN", "DB", "SELECT catalog_items — quarantined rows are not there to be returned", "plain");
  msg("KERN", "AGENT", "rows, each marked in_scope for this mandate · every string Tainted<T>", "refuse");
  msg("AGENT", "EDGE", "MCP get_quote { mandate_id, items: [{ sku, quantity }] }", "plain");
  msg("KERN", "KERN", "price the basket server-side from the merchant's catalog. the agent supplies skus, never prices", "bind");
  msg("KERN", "AGENT", "signed Quote { quote_id, mandate_id, basket_hash, amount_paise, exp, kid } · single use · INV-14", "bind");
  msg("AGENT", "AGENT", "assemble the Intent — the type system rejects Tainted<T> in amount_paise or merchant_id", "refuse");
  msg("AGENT", "EDGE", "MCP purchase { quote_id, reason } + ed25519 signature over the canonical intent", "plain");
  msg("EDGE", "EDGE", "token bucket: 30/min per agent · 10/min per mandate → LMT-005", "refuse");
  msg("EDGE", "KERN", "Intent", "plain");
  msg("KERN", "KERN", "1  stateless: signature · nonce · expiry · taint · quote sig · quote.mandate_id == intent.mandate_id", "bind");
  msg("KERN", "KERN", "2  blind verifier — outside any transaction, downgrade-only, 1.5s. PROCEED is not a grant · INV-17", "bind");
  msg("KERN", "DB", "BEGIN READ COMMITTED · SELECT … FROM mandates WHERE mandate_id = ? FOR UPDATE", "bind");
  msg("KERN", "DB", "3–4  mandate live · unrevoked · binds THIS agent · basket category within scope", "bind");
  msg("KERN", "DB", "5  burn the nonce — a byte-for-byte resubmission dies here", "refuse");
  msg("KERN", "DB", "6  CAP READ: SUM over reservations in ('held','captured') in the window — from the DB · INV-05", "bind");
  msg("KERN", "KERN", "7–8  pure fold: per-txn ₹5,000 · cumulative ₹15,000/30d · velocity · silent ₹500 · first failure wins", "bind");
  msg("KERN", "DB", "9–10  consume the quote · INSERT reservation('held') + ledger INTENT, DECISION, RESERVATION", "ev");
  msg("KERN", "DB", "COMMIT — the reservation is durable before any money can move", "ev");
  msg("KERN", "EXEC", "11  execute { intent_id, quote, idempotency_key = sha256(intent_id) } — AFTER commit, never during", "bind");
  msg("EXEC", "DB", "INSERT orders (SUBMITTING) and COMMIT before the outbound call — a timeout is not a no-op", "ev");
  msg("EXEC", "RZP", "POST /orders + capture · X-Razorpay-Idempotency-Key · assertEgressPermitted() first", "rail");
  msg("RZP", "EXEC", "order created and debited against the Reserve Pay authority — no PIN, no prompt, no notification", "rail");
  msg("EXEC", "DB", "INSERT ledger API_CALL", "ev");
  msg("KERN", "AGENT", "ALLOW · OK-000 · { intent_id, audit_url }", "bind");
  msg("AGENT", "SHOP", "\"done — ₹423.50 at Sharma Kirana\"", "plain");

  /* ---- P5 ---- */
  phase("P5 · PURCHASE — THE STEP-UP VARIANT", "above the ₹500 silent threshold. a step-up is a verdict, not an error: it is written to the ledger before the agent is told.");
  msg("KERN", "DB", "verdict STEP_UP · STP-001 · INSERT ledger DECISION — logged before the handler can forget to", "ev");
  msg("KERN", "AGENT", "STEP_UP · STP-001 · approval_url. NOT a failure, and must not be retried", "refuse");
  msg("AGENT", "SHOP", "show approval_url — the agent cannot approve on the shopper's behalf", "refuse");
  msg("SHOP", "EDGE", "GET /agent/approve/:challenge — single use, bound to this intent_id, short expiry", "bind");
  msg("EDGE", "KERN", "render the amount and basket from the SIGNED QUOTE, and the merchant from the allowlist", "bind");
  msg("SHOP", "RZP", "approve + UPI PIN — the rail's factor IS the step-up factor. no second OTP to train them past", "rail");
  msg("KERN", "KERN", "re-enter the authorisation transaction from the top, step-up now satisfied. no shortcut path", "bind");

  /* ---- P6 ---- */
  phase("P6 · SETTLEMENT", "three controls, because a signature proves only one of the three things that matter: origin, uniqueness, and truth.");
  msg("RZP", "EDGE", "POST /agent/webhooks/razorpay · payment.captured", "rail");
  msg("EDGE", "KERN", "HMAC-SHA256 verified → proves ORIGIN, and nothing else", "bind");
  msg("KERN", "DB", "INSERT webhook_events (provider_event_id) → a duplicate is a PK violation, inside the txn · INV-15", "ev");
  msg("KERN", "RZP", "orders.fetch — re-read current TRUTH. never trust the payload alone", "rail");
  msg("KERN", "DB", "INSERT ledger WEBHOOK + EXECUTION_RESULT — the row every future cap query sums over", "ev");
  msg("KERN", "STORE", "POST /internal/agent/fulfil (x-agentkit-token) — the purchase becomes a real order in their system", "plain");
  msg("STORE", "SHOP", "goods dispatched · the merchant's own order id, in the merchant's own dashboard", "plain");

  /* ---- P7 ---- */
  phase("P7 · FAILURE & REPAIR", "there is no edge from AMBIGUOUS back to SUBMITTED. the missing arrow is the double charge that never happens.");
  msg("EXEC", "EXEC", "no terminal webhook inside the SLA → orders.state = AMBIGUOUS. the hold stays held", "refuse");
  msg("WORK", "RZP", "reconcile-ambiguous: orders.fetch with exponential backoff — resolve by READING · INV-07", "rail");
  msg("WORK", "DB", "INSERT ledger RECONCILE → CAPTURED | FAILED", "ev");
  msg("SHOP", "KERN", "revoke — takes the SAME SELECT … FOR UPDATE that authorisation takes · INV-09", "bind");
  msg("WORK", "RZP", "compensate-revoked: refunds.create for a payment already in flight", "rail");
  msg("WORK", "DB", "INSERT ledger REFUND — a compensating entry. the chain is never edited", "ev");
  msg("WORK", "DB", "release-stale-reservations: a hold with no order row → released, cap returned · INV-20", "ev");
  msg("WORK", "DB", "expire-mandates: validity elapsed → expired, before anything can be authorised against it", "ev");
  msg("WORK", "DB", "verify-chain + anchor: recompute every chain from raw rows, write ANCHOR. a tamper is caught here", "ev");

  /* ---- P8 ---- */
  phase("P8 · THE AUDIT — WHY, NOT WHETHER", "their dashboard answers did the money move. this answers why it was allowed to.");
  msg("SHOP", "EDGE", "GET /agent/audit/:intent_id — or paste the intent_id from the Razorpay order's notes field", "plain");
  msg("EDGE", "KERN", "every ledger entry for that purchase, in chain order, payloads redacted", "plain");
  msg("KERN", "SHOP", "INTENT → DECISION (the rule, the observed value, the bound) → RESERVATION → API_CALL → WEBHOOK → RESULT", "ev");
  msg("STORE", "EDGE", "the merchant sees the same chain, scoped by RLS — and every operator impersonation is IN it", "bind");

  const laneBottom = y - ROW + 12;

  // lane lines behind everything
  const laneLines = [];
  LANES.forEach((l, i) => {
    const x = M + laneW * i + laneW / 2;
    laneLines.push(
      `<line x1="${r(x)}" y1="${r(laneTop)}" x2="${r(x)}" y2="${r(laneBottom)}" stroke="${C.line}" stroke-width="1"/>`,
    );
    if (i > 0)
      laneLines.push(
        `<line x1="${r(M + laneW * i)}" y1="${r(laneTop)}" x2="${r(M + laneW * i)}" y2="${r(laneBottom)}" stroke="#EFF2F6" stroke-width="1"/>`,
      );
  });
  // insert right after the lane header rects (index: everything before laneTop was header)
  d.parts.splice(0, 0, ...laneLines);

  y = laneBottom + 26;
  d.line(M, y, W - M, y, { stroke: C.ink, sw: 1.4 });
  y += 20;

  const key = [
    ["ordinary call — a read, a render, a forward", C.ink],
    ["carries or checks a binding: a signature, a lock, a scope, a key", C.blue],
    ["writes evidence to the ledger, or indexes the discovery plane", C.green],
    ["a refusal, a quarantine, a taint, or something that must not be retried", C.red],
    ["crosses to the rail — Razorpay or NPCI, whose bounds are not ours", C.amber],
  ];
  const half = (W - M * 2) / 2;
  key.forEach((k, i) => {
    const col = i % 2;
    const rowI = Math.floor(i / 2);
    const x = M + col * half;
    const ly = y + rowI * 17;
    d.line(x, ly - 4, x + 24, ly - 4, { stroke: k[1], sw: 1.1, marker: MARKER[i === 0 ? "ink" : i === 1 ? "blue" : i === 2 ? "green" : i === 3 ? "red" : "amber"] });
    d.text(x + 30, ly, k[0], { size: 8.9, fill: C.muted });
  });
  y += 17 * Math.ceil(key.length / 2) + 14;
  d.text(
    M,
    y,
    `${n} steps. Nothing in the demo is simulated: each one is an HTTP call to the kernel, which reaches an executor, which reaches a rail over a real socket.`,
    { size: 9.2, fill: C.muted },
  );
  y += 24;

  return d.render(y);
}

/* ------------------------------------------------------------------------ write */

mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, "fig4-architecture-complete.svg"), architecture());
writeFileSync(resolve(OUT, "fig5-flow-complete.svg"), flow());
console.log("wrote fig4-architecture-complete.svg and fig5-flow-complete.svg to", OUT);
