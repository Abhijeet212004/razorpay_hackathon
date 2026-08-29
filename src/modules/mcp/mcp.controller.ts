import type { Pool } from "pg";
import type { KernelContext } from "../authorization/authorization.service.js";
import type { RequestContext } from "../../shared/http.js";
import { silentLogger } from "../../shared/logger.js";
import { callerKey, consume } from "../ratelimit/ratelimit.service.js";
import { callTool, type McpOptions } from "./mcp.service.js";
import { createSession, resolveSession, revokeSession } from "./mcp.session.js";
import { toolsFor } from "./mcp.tools.js";
import {
  JsonRpcRequestSchema,
  PROTOCOL_VERSION,
  RPC,
  ToolCallSchema,
  fail,
  ok,
  type JsonRpcResponse,
} from "./mcp.validation.js";

/**
 * MCP over Streamable HTTP.
 *
 * A second door onto the same tools. What arrives here is JSON-RPC from an untrusted
 * client, so it is validated like any other public input, and every method that spends
 * money goes through the same policy engine the HTTP surface uses.
 *
 * The session id travels in the Mcp-Session-Id header, as the protocol specifies. It is a
 * bearer credential: it identifies an agent and grants nothing.
 */

export interface McpDeps {
  readonly pool: Pool;
  readonly kernel: KernelContext;
  readonly options: McpOptions;
  /** Only true behind a proxy that overwrites X-Forwarded-For. */
  readonly trustProxy?: boolean;
}

/** Which bucket a tool call is charged to. Sending an SMS costs far more than a search. */
function bucketFor(method: string, toolName?: string): string {
  if (method === "initialize") return "session";
  if (toolName === "request_permission") return "consent";
  if (toolName === "get_quote") return "quote";
  if (toolName === "purchase" || toolName === "cancel_order") return "mandate";
  return "agent";
}

const SESSION_HEADER = "mcp-session-id";

function header(ctx: RequestContext, name: string): string | undefined {
  const value = ctx.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export async function handleMcp(
  deps: McpDeps,
  ctx: RequestContext,
): Promise<{ status: number; body: unknown; headers?: Record<string, string> }> {
  const logger = deps.options.logger ?? silentLogger;

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(ctx.rawBody);
  } catch {
    return { status: 400, body: fail(null, RPC.PARSE_ERROR, "invalid JSON") };
  }

  // A batch is a list. Each entry is handled independently; one bad entry does not
  // poison the rest.
  const batch = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
  if (batch.length === 0 || batch.length > 20) {
    return { status: 400, body: fail(null, RPC.INVALID_REQUEST, "empty or oversized batch") };
  }

  const responses: JsonRpcResponse[] = [];
  let issuedSession: string | undefined;

  for (const entry of batch) {
    const parsed = JsonRpcRequestSchema.safeParse(entry);
    if (!parsed.success) {
      responses.push(fail(null, RPC.INVALID_REQUEST, "not a JSON-RPC 2.0 request"));
      continue;
    }

    const { id, method, params } = parsed.data;
    const rpcId = id ?? null;

    // A notification expects no reply. `initialized` is the client telling us it is ready.
    const isNotification = id === undefined;

    try {
      switch (method) {
        case "initialize": {
          // Before a session exists the caller is only an address, so this is the one
          // bucket that has to hold against an anonymous flood.
          const caller = callerKey(ctx.headers, deps.trustProxy === true);
          const limit = await consume(deps.pool, deps.options.merchantId, "session", caller);
          if (!limit.allowed) {
            logger.count("mcp.rate_limited.session");
            responses.push(
              fail(rpcId, RPC.RATE_LIMITED, "too many sessions — try again shortly", {
                reason_code: "LMT-005",
                retry_after_seconds: limit.retryAfter,
              }),
            );
            continue;
          }

          const clientName =
            typeof params?.clientInfo === "object" && params.clientInfo !== null
              ? String((params.clientInfo as { name?: unknown }).name ?? "unknown client")
              : "unknown client";

          const session = await createSession(
            deps.pool,
            deps.options.merchantId,
            clientName,
          );
          issuedSession = session.sessionId;
          logger.count("mcp.session.created");

          responses.push(
            ok(rpcId, {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: { tools: { listChanged: false } },
              serverInfo: {
                name: `agentkit · ${deps.options.merchantId}`,
                version: "1.0.0",
              },
              // The session's own agent id. A shopper granting permission from the
              // merchant's site has to be able to name which agent they mean, and the
              // agent is the only one that knows. Publishing it grants nothing: an id
              // without a mandate is refused everywhere money is involved.
              agentId: session.agentId,
              instructions:
                "You are shopping on behalf of a person. You cannot set prices and you " +
                "cannot pay without permission they granted. Every purchase returns one " +
                "of ALLOW, STEP_UP or DENY with a single reason code. STEP_UP means a " +
                "human must approve — show them the link and stop; it is not a failure " +
                "and must not be retried. DENY means do not retry the same request. " +
                `Your agent id is ${session.agentId}. If the shopper wants their order ` +
                "delivered to a saved address, tell them this id and ask them to grant " +
                "permission from the merchant's own account page, which binds it to them.",
            }),
          );
          continue;
        }

        case "notifications/initialized":
        case "notifications/cancelled":
          continue;

        case "ping":
          if (!isNotification) responses.push(ok(rpcId, {}));
          continue;
      }

      // Everything past this point needs a session.
      const session = await resolveSession(
        deps.pool,
        deps.options.merchantId,
        header(ctx, SESSION_HEADER),
      );

      if (session === null) {
        logger.count("mcp.unauthenticated");
        responses.push(
          fail(rpcId, RPC.UNAUTHENTICATED, "no valid session — call initialize first"),
        );
        continue;
      }

      switch (method) {
        case "tools/list":
          responses.push(
            ok(rpcId, {
              tools: toolsFor(deps.options.exposed).map((tool) => ({
                name: tool.name,
                title: tool.title,
                description: tool.description,
                inputSchema: tool.inputSchema,
              })),
            }),
          );
          break;

        case "tools/call": {
          const call = ToolCallSchema.safeParse(params);
          if (!call.success) {
            responses.push(fail(rpcId, RPC.INVALID_PARAMS, "name is required"));
            break;
          }

          // Charged per tool: a search is cheap, an SMS is not.
          const bucket = bucketFor(method, call.data.name);
          const limit = await consume(
            deps.pool,
            deps.options.merchantId,
            bucket,
            session.agentId,
          );
          if (!limit.allowed) {
            logger.count(`mcp.rate_limited.${bucket}`);
            responses.push(
              fail(rpcId, RPC.RATE_LIMITED, "you are going too fast — slow down", {
                reason_code: "LMT-005",
                retry_after_seconds: limit.retryAfter,
              }),
            );
            break;
          }

          const result = await callTool(
            deps.pool,
            deps.kernel,
            deps.options,
            session,
            call.data.name,
            call.data.arguments ?? {},
          );
          responses.push(ok(rpcId, result));
          break;
        }

        case "shutdown":
          await revokeSession(deps.pool, deps.options.merchantId, session.sessionId);
          responses.push(ok(rpcId, {}));
          break;

        default:
          responses.push(fail(rpcId, RPC.METHOD_NOT_FOUND, `no such method: ${method}`));
      }
    } catch (error) {
      logger.error(`mcp ${method} failed`, error);
      logger.count("mcp.internal_error");
      // The message never crosses the boundary.
      responses.push(fail(rpcId, RPC.INTERNAL, "internal error"));
    }
  }

  // Notifications only: nothing to say.
  if (responses.length === 0) return { status: 202, body: "" };

  return {
    status: 200,
    body: Array.isArray(parsedBody) ? responses : responses[0],
    ...(issuedSession === undefined ? {} : { headers: { "Mcp-Session-Id": issuedSession } }),
  };
}
