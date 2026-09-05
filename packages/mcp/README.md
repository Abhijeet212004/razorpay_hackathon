# @agentkit/mcp

Connects an MCP client such as Claude Desktop to a merchant's AgentKit endpoint.

Claude Desktop launches MCP servers as local processes and speaks newline-delimited
JSON-RPC over stdin and stdout. A merchant's AgentKit endpoint is HTTP, because it has to
serve every agent rather than one desktop. This is the piece in between.

```
claude_desktop_config.json -> agentkit-mcp -> https://merchant/agent/mcp
```

## Use

Add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sharma-kirana": {
      "command": "npx",
      "args": ["-y", "@agentkit/mcp", "https://yourshop.in/agent/mcp"],
      "env": { "AGENTKIT_API_KEY": "ak_live_..." }
    }
  }
}
```

Quit Claude Desktop before editing the file. It rewrites the config on launch and
discards edits made while it is running.

`AGENTKIT_API_KEY` is optional. Without it the bridge connects anonymously, which works
against a single-merchant kernel and is refused by a hosted one.

## Directly

```
agentkit-mcp https://yourshop.in/agent/mcp
AGENTKIT_MCP_URL=https://yourshop.in/agent/mcp agentkit-mcp
```

## What it guarantees

1. **Nothing but JSON-RPC reaches stdout.** A stray log line corrupts the stream and the
   client disconnects with no useful error. Diagnostics go to stderr.
2. **The session id is carried.** The `Mcp-Session-Id` issued at `initialize` goes on
   every later request. Losing it turns every call into "no valid session".
3. **A notification gets no reply.** A 202 with an empty body is answered with silence,
   not with a JSON-RPC response the client never asked for.

## Licence

Apache-2.0
