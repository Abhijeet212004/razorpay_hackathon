#!/usr/bin/env node
/**
 * Prints the Claude Desktop configuration for a merchant's AgentKit endpoint, and offers
 * to write it.
 *
 * This is what a merchant gives their customers: one block of JSON, and Claude can shop
 * with them. It is also the honest answer to "how does Claude find the merchant" — for
 * now, somebody tells it. There is no registry of agent-transactable merchants yet, which
 * is exactly the gap the .well-known manifest exists to fill once there is one.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

// Flags are not positional arguments. Reading argv[2] blindly turned `--write` into the
// merchant URL and wrote a config pointing at "--write/agent/mcp".
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const MERCHANT = positional[0] ?? process.env.MERCHANT_URL ?? "http://localhost:58080";
const NAME = positional[1] ?? "sharma-kirana";

const bridge = resolve(new URL("./mcp-stdio.mjs", import.meta.url).pathname);

function configPath() {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "win32":
      return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    default:
      return join(home, ".config", "Claude", "claude_desktop_config.json");
  }
}

const entry = {
  command: "node",
  args: [bridge, `${MERCHANT}/agent/mcp`],
};

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const ok = (s) => `\x1b[32m${s}\x1b[0m`;

console.log(`\n${bold("Connect Claude Desktop to this merchant")}\n`);
console.log(dim(`  config: ${configPath()}`));
console.log(dim(`  server: ${MERCHANT}/agent/mcp\n`));
console.log(JSON.stringify({ mcpServers: { [NAME]: entry } }, null, 2));

if (!process.argv.includes("--write")) {
  console.log(`\n${dim("  re-run with --write to merge this into your Claude Desktop config")}`);
  console.log(dim("  then restart Claude Desktop and ask it to shop\n"));
  process.exit(0);
}

const path = configPath();
mkdirSync(dirname(path), { recursive: true });

let existing = {};
if (existsSync(path)) {
  try {
    existing = JSON.parse(readFileSync(path, "utf8"));
    // Never clobber a config with other servers in it.
    writeFileSync(`${path}.backup`, JSON.stringify(existing, null, 2));
    console.log(dim(`\n  backed up your existing config to ${path}.backup`));
  } catch {
    console.error("\n  your existing config is not valid JSON — fix or remove it first\n");
    process.exit(1);
  }
}

existing.mcpServers = { ...(existing.mcpServers ?? {}), [NAME]: entry };
writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`);

console.log(`\n  ${ok("written")}. Restart Claude Desktop, then try:\n`);
for (const prompt of [
  '"what does Sharma Kirana sell under ₹100?"',
  '"get me milk and bread"',
  '"buy 100 units of everything"   ← watch it get refused',
]) console.log(`    ${dim(prompt)}`);
console.log("");
