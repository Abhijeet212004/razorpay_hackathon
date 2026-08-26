import { z } from "zod";

/**
 * JSON-RPC 2.0, which is what MCP speaks.
 *
 * Everything crossing this boundary is validated before it reaches a handler. An MCP
 * client is an agent; an agent is untrusted; so the transport gets the same treatment as
 * any other public input.
 */

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  // Absent on notifications, which expect no reply.
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().min(1).max(120),
  params: z.record(z.unknown()).optional(),
});

export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** JSON-RPC reserved codes, plus the ones this server adds. */
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  /** No session, or one that has expired or been revoked. */
  UNAUTHENTICATED: -32001,
  /** The merchant has not exposed this tool class. */
  FORBIDDEN: -32002,
  RATE_LIMITED: -32003,
} as const;

export function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function fail(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  // `message` is written for the caller. Internal detail never reaches it — an error
  // string is an oracle like any other.
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/** MCP revision this server implements. */
export const PROTOCOL_VERSION = "2025-06-18";

export const ToolCallSchema = z.object({
  name: z.string().min(1).max(120),
  arguments: z.record(z.unknown()).optional(),
});
