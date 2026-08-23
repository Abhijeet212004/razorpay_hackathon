#!/usr/bin/env node
/**
 * Generates the invariant table's file:line column by finding every INV-NN marker in the
 * tree. Maintained by hand it goes stale the first time anything moves, and a table of
 * stale paths is worse than no table.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const ROOTS = ["src", "migrations", "tests"];
const MARKER = /INV-(\d{2})\b/g;
const SKIP = new Set(["node_modules", ".git", "dist", "coverage"]);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(ts|sql|mjs)$/.test(entry.name)) yield full;
  }
}

const found = new Map();

for (const root of ROOTS) {
  for await (const file of walk(root)) {
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((line, index) => {
      for (const match of line.matchAll(MARKER)) {
        const id = `INV-${match[1]}`;
        const site = { file, line: index + 1, test: file.startsWith("tests/") };
        found.set(id, [...(found.get(id) ?? []), site]);
      }
    });
  }
}

// All twenty-three, so the table shows what is not yet enforced as well as what is.
const ALL = Array.from({ length: 23 }, (_, i) => `INV-${String(i + 1).padStart(2, "0")}`);
const ids = ALL;
const rows = ids.map((id) => {
  const sites = found.get(id) ?? [];
  const enforcement = sites.filter((s) => !s.test);
  const tests = sites.filter((s) => s.test);
  return {
    id,
    enforcement: enforcement.map((s) => `${s.file}:${s.line}`),
    tests: tests.map((s) => `${s.file}:${s.line}`),
  };
});

const width = (key) => Math.max(...rows.map((r) => r[key].join(" · ").length), key.length);
const w1 = width("enforcement");

console.log("| ID | Enforcement point | Test |");
console.log(`|---|${"-".repeat(Math.min(w1, 60))}|---|`);
for (const row of rows) {
  const enforcement = row.enforcement.join(" · ") || "—";
  const tests = row.tests.join(" · ") || "—";
  console.log(`| ${row.id} | \`${enforcement}\` | \`${tests}\` |`);
}

const unmarked = rows.filter((r) => r.enforcement.length === 0);
const untested = rows.filter((r) => r.enforcement.length > 0 && r.tests.length === 0);

console.log(
  `\n${rows.length - unmarked.length}/${rows.length} invariants have an enforcement marker.`,
);
if (unmarked.length > 0) {
  console.log(`not yet enforced: ${unmarked.map((r) => r.id).join(", ")}`);
}

// An enforcement point with no test is the failure this table exists to surface.
if (untested.length > 0) {
  console.error(`\nenforced but untested: ${untested.map((r) => r.id).join(", ")}`);
  process.exit(1);
}
