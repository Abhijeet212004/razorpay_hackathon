import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * A very small router. No framework: the boundary between the outside world and the
 * kernel is the product, and a third-party abstraction with its own body parsing, retry
 * and error handling would sit exactly on it.
 */

export interface RequestContext {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly params: Readonly<Record<string, string>>;
  readonly headers: IncomingMessage["headers"];
  /** The exact bytes received. Webhook signatures are over these, not over a re-encode. */
  readonly rawBody: string;
}

export interface HandlerResult {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

export type Handler = (ctx: RequestContext) => Promise<HandlerResult> | HandlerResult;

export interface Route {
  readonly method: string;
  /** Supports one level of :param, which is all any route here needs. */
  readonly path: string;
  readonly handler: Handler;
}

function match(routePath: string, actual: string): Record<string, string> | null {
  const expected = routePath.split("/");
  const got = actual.split("/");
  if (expected.length !== got.length) return null;

  const params: Record<string, string> = {};
  for (const [index, segment] of expected.entries()) {
    const value = got[index] ?? "";
    if (segment.startsWith(":")) params[segment.slice(1)] = decodeURIComponent(value);
    else if (segment !== value) return null;
  }
  return params;
}

export function createHttpService(routes: readonly Route[]): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    let rawBody = "";
    req.on("data", (chunk) => (rawBody += chunk));
    req.on("end", () => {
      void (async () => {
        const url = new URL(req.url ?? "/", "http://service");

        for (const route of routes) {
          if (route.method !== (req.method ?? "GET")) continue;
          const params = match(route.path, url.pathname);
          if (params === null) continue;

          try {
            const result = await route.handler({
              method: req.method ?? "GET",
              path: url.pathname,
              query: url.searchParams,
              params,
              headers: req.headers,
              rawBody,
            });
            // A string body is already the payload — an HTML page must not be handed
            // back JSON-encoded, quotes and all.
            const isText = typeof result.body === "string";
            res.writeHead(result.status, {
              "Content-Type": isText ? "text/html; charset=utf-8" : "application/json",
              ...(result.headers ?? {}),
            });
            res.end(isText ? (result.body as string) : JSON.stringify(result.body));
          } catch (error) {
            // The message never crosses the boundary: it can carry internal detail, and
            // a caller has no use for it.
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "internal_error" }));
            console.error("[agentkit] unhandled", error);
          }
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      })();
    });
  });
}

export function listen(server: Server, port: number, name: string): Promise<void> {
  return new Promise((resolve) => {
    server.listen(port, "0.0.0.0", () => {
      console.log(`[agentkit] ${name} listening on ${port}`);
      resolve();
    });
  });
}
