#!/usr/bin/env node
/**
 * stdio ↔ HTTP bridge for MCP.
 *
 * Claude Desktop launches MCP servers as local processes and speaks newline-delimited
 * JSON-RPC over stdin and stdout. A merchant's AgentKit endpoint is HTTP, because it has
 * to serve every agent rather than one desktop. This is the ~80 lines in between.
 *
 *   claude_desktop_config.json → this process → https://merchant/agent/mcp
 *
 * Two rules it must not break:
 *
 *   1. Nothing but JSON-RPC goes to stdout. A stray console.log corrupts the stream and
 *      the client disconnects with no useful error. Diagnostics go to stderr.
 *   2. The Mcp-Session-Id from initialize is carried on every later request. Losing it
 *      turns every call into "no valid session".
 *
 * Usage:
 *   agentkit-mcp https://sharmakirana.in/agent/mcp
 */

import { createInterface } from "node:readline";

const endpoint = process.argv[2] ?? process.env.AGENTKIT_MCP_URL;

if (endpoint === undefined) {
  process.stderr.write("usage: agentkit-mcp <merchant mcp url>\n");
  process.exit(2);
}

const log = (message) => process.stderr.write(`[agentkit-mcp] ${message}\n`);

let sessionId;

log(`bridging stdio → ${endpoint}`);

async function forward(message) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(sessionId === undefined ? {} : { "Mcp-Session-Id": sessionId }),
    },
    body: JSON.stringify(message),
  });

  const issued = response.headers.get("mcp-session-id");
  if (issued !== null && issued !== sessionId) {
    sessionId = issued;
    log(`session established`);
  }

  // 202 with an empty body is the correct answer to a notification.
  const text = await response.text();
  if (text.length === 0) return undefined;

  try {
    return JSON.parse(text);
  } catch {
    log(`merchant returned ${response.status} with a body that is not JSON`);
    return {
      jsonrpc: "2.0",
      id: message.id ?? null,
      error: { code: -32603, message: "merchant returned a malformed response" },
    };
  }
}

const stdin = createInterface({ input: process.stdin });

for await (const line of stdin) {
  const trimmed = line.trim();
  if (trimmed.length === 0) continue;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "invalid JSON" },
      })}\n`,
    );
    continue;
  }

  try {
    const reply = await forward(message);
    // A notification gets no reply, and writing one would confuse the client.
    if (reply !== undefined) process.stdout.write(`${JSON.stringify(reply)}\n`);
  } catch (error) {
    log(`could not reach the merchant: ${String(error)}`);
    if (message.id !== undefined) {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: "could not reach the merchant" },
        })}\n`,
      );
    }
  }
}

log("stdin closed, exiting");
