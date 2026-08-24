#!/usr/bin/env node
/**
 * Deletes each control, re-runs the test that exists to catch it, restores everything,
 * and prints a table.
 *
 * The point is not that the tests pass. It is that they are load-bearing: a test which
 * stays green after its control is removed was decorative, and this is the only way to
 * find out which ones those are.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const CONTROLS = [
  {
    name: "row lock on the mandate",
    file: "src/modules/authorization/authorization.repository.ts",
    find: "      FOR UPDATE`,",
    replace: "      `,",
    test: "tests/security/concurrency.test.ts",
    expect: "fifty concurrent intents are admitted, cap exceeded",
  },
  {
    name: "reservation counted in the cap",
    file: "src/modules/authorization/authorization.repository.ts",
    find: "        AND state IN ('held', 'captured')\n        AND created_at > now() - $2::interval`,",
    replace: "        AND state IN ('captured')\n        AND created_at > now() - $2::interval`,",
    test: "tests/security/concurrency.test.ts",
    expect: "settled-only accounting lets every intent through",
  },
  {
    name: "FORCE row level security",
    file: "migrations/004_rls.sql",
    find: "ALTER TABLE ledger         FORCE  ROW LEVEL SECURITY;",
    replace: "-- removed by prove",
    test: "tests/infra/rls.test.ts",
    expect: "the table owner reads across merchants",
  },
  {
    name: "quote bound to its mandate",
    file: "src/modules/authorization/authorization.stateless.ts",
    find: '  if (quote.mandate_id !== intent.mandate_id) return "INT-004";',
    replace: "",
    test: "tests/security/compromised-model.test.ts",
    expect: "a quote is spendable under another mandate",
  },
  {
    name: "append-only ledger grants",
    file: "migrations/005_grants.sql",
    find: "REVOKE UPDATE, DELETE, TRUNCATE ON ledger, ledger_anchor\n  FROM agentkit_kernel, agentkit_worker, agentkit_console, agentkit_admin;",
    replace: "GRANT UPDATE, DELETE ON ledger TO agentkit_kernel;",
    test: "tests/infra/grants.test.ts",
    expect: "history becomes editable",
  },
  {
    name: "hash recomputed from raw rows",
    file: "src/modules/ledger/ledger.service.ts",
    find: "    const recomputed = chainHash(expectedPrev, entry.payloadRedacted);\n    if (!recomputed.equals(entry.hash)) {",
    replace: "    const recomputed = entry.hash;\n    if (!recomputed.equals(entry.hash)) {",
    test: "tests/security/chain.test.ts",
    expect: "a tampered payload verifies",
  },
  {
    name: "nonce burn",
    file: "src/modules/policy/policy.service.ts",
    find: '      rule: "intent.nonceUnspent",\n      passed: !facts.nonceAlreadySpent,',
    replace: '      rule: "intent.nonceUnspent",\n      passed: true,',
    test: "tests/security/compromised-model.test.ts",
    expect: "a captured intent can be replayed",
  },
];

function run(test) {
  try {
    execFileSync("npx", ["vitest", "run", test], {
      stdio: "pipe",
      env: { ...process.env, TESTCONTAINERS_RYUK_DISABLED: "true" },
    });
    return "GREEN";
  } catch {
    return "RED";
  }
}

const results = [];

for (const control of CONTROLS) {
  const original = readFileSync(control.file, "utf8");
  if (!original.includes(control.find)) {
    results.push({ ...control, outcome: "ANCHOR MISSING" });
    continue;
  }

  process.stderr.write(`  removing ${control.name} ... `);
  writeFileSync(control.file, original.replace(control.find, control.replace));

  let outcome;
  try {
    outcome = run(control.test) === "RED" ? "caught" : "NOT CAUGHT";
  } finally {
    writeFileSync(control.file, original);
  }

  process.stderr.write(`${outcome}\n`);
  results.push({ ...control, outcome });
}

const width = Math.max(...results.map((r) => r.name.length));
console.log("");
console.log(`| ${"control removed".padEnd(width)} | test | result |`);
console.log(`|${"-".repeat(width + 2)}|------|--------|`);
for (const r of results) {
  const test = r.test.replace("tests/", "").replace(".test.ts", "");
  console.log(`| ${r.name.padEnd(width)} | ${test} | ${r.outcome === "caught" ? "went red" : r.outcome} |`);
}
console.log("");

const missed = results.filter((r) => r.outcome !== "caught");
if (missed.length > 0) {
  console.error(`${missed.length} control(s) were removed without any test noticing.`);
  process.exit(1);
}
console.log(`${results.length} controls removed, ${results.length} tests went red. None are decorative.`);
