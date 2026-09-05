import { GENESIS_PREV_HASH, chainHash } from "../../shared/crypto/hash.js";
import { canonicalise } from "../../shared/crypto/jcs.js";
import type { ChainEntry } from "../console/console.repository.js";
import { escape, shell, type ShellOptions } from "./dashboard.shell.js";

/**
 * The chain, recomputed in front of the reader.
 *
 * The decision page answers "why did this happen". This answers "why should I believe the
 * record of it". Every claim the system makes about tamper evidence reduces to one line of
 * arithmetic — SHA256(prev_hash || JCS(payload)) — and that line is either reproducible or
 * it is marketing.
 *
 * So nothing here is read from the hash column and displayed. Each entry is hashed again
 * from its predecessor and its own canonical bytes, and the recomputed value is shown next
 * to the stored one. A row edited in place fails even if its hash column was edited to
 * match, because the next entry commits to the old value.
 */

const DISPLAY_TIME_ZONE = process.env.DISPLAY_TIME_ZONE ?? "Asia/Kolkata";

function stamp(date: Date): string {
  return date.toLocaleString("en-IN", {
    timeZone: DISPLAY_TIME_ZONE,
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

/** Hex in fixed-width pairs, so two hashes can be compared by eye. */
function hex(buffer: Buffer): string {
  return (buffer.toString("hex").match(/.{1,8}/g) ?? []).join(" ");
}

interface Checked {
  readonly entry: ChainEntry;
  readonly canonical: string;
  readonly recomputed: Buffer;
  readonly hashMatches: boolean;
  readonly linkMatches: boolean;
  readonly expectedPrev: Buffer;
}

function check(entries: readonly ChainEntry[]): Checked[] {
  return entries.map((entry, index) => {
    const expectedPrev = index === 0 ? GENESIS_PREV_HASH : entries[index - 1]!.hash;
    const recomputed = chainHash(entry.prevHash, entry.hashedPayload as never);
    return {
      entry,
      canonical: canonicalise(entry.hashedPayload as never),
      recomputed,
      hashMatches: recomputed.equals(entry.hash),
      linkMatches: entry.prevHash.equals(expectedPrev),
      expectedPrev,
    };
  });
}

function entryBlock(c: Checked, isFirst: boolean): string {
  const ok = c.hashMatches && c.linkMatches;
  const bytes = Buffer.byteLength(c.canonical, "utf8");

  return `
<section class="cx${ok ? "" : " cx-bad"}">
  <header class="cxh">
    <span class="cxseq">#${c.entry.seq}</span>
    <span class="cxkind">${escape(c.entry.kind)}</span>
    <span class="cxwhen">${escape(stamp(c.entry.createdAt))}</span>
    <span class="cxverdict">${ok ? "verified" : "DOES NOT VERIFY"}</span>
  </header>

  <div class="cxrow">
    <div class="cxlabel">prev_hash</div>
    <div class="cxval"><code>${escape(hex(c.entry.prevHash))}</code>
      ${isFirst
        ? `<p class="cxnote">Thirty-two zero bytes. This is the first entry on the chain, so
           there is nothing before it to commit to.</p>`
        : c.linkMatches
          ? `<p class="cxnote">Matches the hash of entry #${c.entry.seq - 1}. That is the link:
             changing anything in that entry changes this value, and every value after it.</p>`
          : `<p class="cxnote cxwarn">Does not match entry #${c.entry.seq - 1}. Expected
             <code>${escape(hex(c.expectedPrev))}</code>. The chain is broken here.</p>`}
    </div>
  </div>

  <div class="cxrow">
    <div class="cxlabel">canonical bytes</div>
    <div class="cxval">
      <pre class="cxbytes">${escape(c.canonical)}</pre>
      <p class="cxnote">RFC 8785. Keys sorted, no insignificant whitespace, ${bytes} bytes.
        The same object serialised any other way hashes differently, which is why the rule
        is a specification rather than a convention.</p>
    </div>
  </div>

  <div class="cxrow">
    <div class="cxlabel">recomputed</div>
    <div class="cxval">
      <p class="cxformula"><code>SHA256( prev_hash &#8214; canonical bytes )</code></p>
      <code>${escape(hex(c.recomputed))}</code>
      ${c.hashMatches
        ? `<p class="cxnote">Identical to the stored hash. Recomputed here from the row, not
           copied from it.</p>`
        : `<p class="cxnote cxwarn">Stored value is
           <code>${escape(hex(c.entry.hash))}</code>. This row has been altered.</p>`}
    </div>
  </div>
</section>`;
}

export function chainPage(
  opts: ShellOptions,
  intentId: string,
  chainId: string | null,
  entries: readonly ChainEntry[],
): string {
  if (chainId === null || entries.length === 0) {
    return shell(opts, `
      <h1>Chain</h1>
      <p class="sub">Nothing on record for <code>${escape(intentId)}</code>.</p>`);
  }

  const checked = check(entries);
  const broken = checked.find((c) => !c.hashMatches || !c.linkMatches);
  const forThisIntent = checked.filter((c) => c.entry.ref === intentId).length;

  return shell(opts, `
<h1>Chain</h1>
<p class="sub">Every entry on this permission's chain, with each hash recomputed from the
row rather than read from it.</p>

<div class="cxsum${broken === undefined ? "" : " cxsum-bad"}">
  <div><span class="cxk">Chain</span><code>${escape(chainId)}</code></div>
  <div><span class="cxk">Entries</span>${checked.length}</div>
  <div><span class="cxk">For this intent</span>${forThisIntent}</div>
  <div><span class="cxk">Result</span>${
    broken === undefined
      ? "every hash and every link verifies"
      : `first failure at entry #${broken.entry.seq}`
  }</div>
</div>

<div class="cxexplain">
  <h2>What is being checked</h2>
  <p>One chain per permission. Each entry stores the hash of the one before it, so the
  entries are not merely ordered, they are committed to that order.</p>
  <p><code>hash = SHA256( prev_hash &#8214; JCS(payload) )</code></p>
  <p>Two independent things have to hold, and both are checked below for every entry.
  <strong>The hash</strong> must equal the recomputation from this row's own bytes, which
  catches a payload edited after the fact. <strong>The link</strong> must equal the previous
  entry's hash, which catches an entry removed, reordered, or inserted.</p>
  <p>Editing a row and its hash column together still fails, because the next entry
  committed to the old value. Rewriting the whole chain from that point is the only way,
  and the database forbids it: <code>UPDATE</code>, <code>DELETE</code> and
  <code>TRUNCATE</code> are revoked on this table for every role the application uses, and
  a unique constraint on <code>(chain_id, prev_hash)</code> makes a second branch
  unwritable.</p>
</div>

<h2 class="cxh2">Entries</h2>
${checked.map((c, i) => entryBlock(c, i === 0)).join("")}

<p class="cxfoot">The same arithmetic runs outside the browser:
<code>agentkit verify</code> recomputes every chain from raw rows and exits non-zero on the
first mismatch.</p>`);
}
