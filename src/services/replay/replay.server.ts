import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

/**
 * The replay rail: a real HTTP server standing where Razorpay stands.
 *
 * It answers on the same paths, with recorded response shapes, and fires real
 * HMAC-signed webhooks back. Everything on our side genuinely executes — the executor's
 * socket handling, the idempotency header, HMAC verification, event dedupe and
 * orders.fetch. Only the far side of the socket is a recording.
 *
 * This is what lets a judge run the whole system with no Razorpay account, without
 * anything being pretended.
 */

interface StoredOrder {
  id: string;
  status: "created" | "attempted" | "paid" | "failed";
  amount: number;
  amount_paid: number;
  notes: Record<string, string>;
  paymentId: string | null;
}

export interface ReplayRailOptions {
  readonly webhookSecret: string;
  /** Where to POST webhooks. Left unset in tests that drive settlement by hand. */
  readonly webhookUrl?: string;
  /** Milliseconds before a captured webhook fires. */
  readonly settleAfterMs?: number;
  /** Fail the payment instead of capturing it, for the failure-path scenario. */
  readonly failPayments?: boolean;
  /** Accept the order, then never send a terminal webhook — produces AMBIGUOUS. */
  readonly goSilent?: boolean;
  /** Fixed port for the compose service; 0 (the default) picks a free one for tests. */
  readonly port?: number;
}

export interface ReplayRail {
  readonly url: string;
  readonly port: number;
  /** Orders seen, so a test can assert the rail was called exactly once per intent. */
  readonly orders: ReadonlyMap<string, StoredOrder>;
  /** Idempotency keys seen, including repeats. */
  readonly idempotencyKeys: readonly string[];
  /** Fires the terminal webhook for an order now, rather than on a timer. */
  settle(railOrderId: string, outcome?: "captured" | "failed"): Promise<void>;
  close(): Promise<void>;
}

function signature(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export async function startReplayRail(options: ReplayRailOptions): Promise<ReplayRail> {
  const orders = new Map<string, StoredOrder>();
  /** Idempotency key to order id, which is what makes a replayed intent collapse. */
  const byIdempotencyKey = new Map<string, string>();
  const idempotencyKeys: string[] = [];
  const refunds = new Map<string, { id: string; status: string; amount: number }>();

  let server: Server;

  async function fireWebhook(event: string, payload: unknown): Promise<void> {
    if (options.webhookUrl === undefined) return;

    const body = JSON.stringify({
      entity: "event",
      event,
      // The reconciler dedupes on this, so a duplicate delivery is harmless.
      id: `evt_${randomUUID().replaceAll("-", "").slice(0, 14)}`,
      created_at: Math.floor(Date.now() / 1000),
      payload,
    });

    await fetch(options.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // A real signature over the real body. Verification is not skipped in replay.
        "X-Razorpay-Signature": signature(options.webhookSecret, body),
      },
      body,
    }).catch(() => undefined);
  }

  async function settle(railOrderId: string, outcome?: "captured" | "failed"): Promise<void> {
    const order = orders.get(railOrderId);
    if (order === undefined) return;

    const failed = outcome === "failed" || (outcome === undefined && options.failPayments === true);

    if (failed) {
      order.status = "failed";
      await fireWebhook("payment.failed", {
        payment: { entity: { id: order.paymentId, order_id: order.id, status: "failed" } },
      });
      return;
    }

    order.status = "paid";
    order.amount_paid = order.amount;
    await fireWebhook("payment.captured", {
      payment: {
        entity: {
          id: order.paymentId,
          order_id: order.id,
          status: "captured",
          amount: order.amount,
          notes: order.notes,
        },
      },
    });
  }

  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://replay");
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };

      // POST /v1/orders
      if (req.method === "POST" && url.pathname === "/v1/orders") {
        const key = req.headers["x-razorpay-idempotency-key"];
        const idempotencyKey = typeof key === "string" ? key : undefined;
        if (idempotencyKey !== undefined) idempotencyKeys.push(idempotencyKey);

        // The rail collapses a replayed request into the original order rather than
        // charging twice. This is the behaviour the idempotency key exists to buy.
        if (idempotencyKey !== undefined && byIdempotencyKey.has(idempotencyKey)) {
          const existing = orders.get(byIdempotencyKey.get(idempotencyKey)!)!;
          send(200, existing);
          return;
        }

        const body = raw.length > 0 ? (JSON.parse(raw) as { amount: number; notes?: Record<string, string> }) : { amount: 0 };
        const id = `order_${randomUUID().replaceAll("-", "").slice(0, 14)}`;
        const order: StoredOrder = {
          id,
          status: "created",
          amount: body.amount,
          amount_paid: 0,
          notes: body.notes ?? {},
          paymentId: `pay_${randomUUID().replaceAll("-", "").slice(0, 14)}`,
        };
        orders.set(id, order);
        if (idempotencyKey !== undefined) byIdempotencyKey.set(idempotencyKey, id);

        send(200, order);

        if (options.goSilent !== true && options.webhookUrl !== undefined) {
          setTimeout(() => void settle(id), options.settleAfterMs ?? 20);
        }
        return;
      }

      // GET /v1/orders/:id
      const orderMatch = /^\/v1\/orders\/(order_[A-Za-z0-9]+)$/.exec(url.pathname);
      if (req.method === "GET" && orderMatch !== null) {
        const order = orders.get(orderMatch[1]!);
        if (order === undefined) {
          send(404, { error: { code: "BAD_REQUEST_ERROR", description: "order not found" } });
          return;
        }
        send(200, {
          ...order,
          payments: {
            entity: "collection",
            items: order.status === "paid" ? [{ id: order.paymentId, status: "captured" }] : [],
          },
        });
        return;
      }

      // POST /v1/payments/:id/refund
      const refundMatch = /^\/v1\/payments\/(pay_[A-Za-z0-9]+)\/refund$/.exec(url.pathname);
      if (req.method === "POST" && refundMatch !== null) {
        const body = raw.length > 0 ? (JSON.parse(raw) as { amount: number }) : { amount: 0 };
        const id = `rfnd_${randomUUID().replaceAll("-", "").slice(0, 14)}`;
        const refund = { id, status: "processed", amount: body.amount };
        refunds.set(id, refund);
        send(200, refund);
        return;
      }

      send(404, { error: { code: "BAD_REQUEST_ERROR", description: "no such route" } });
    });
  });

  const host = options.port === undefined ? "127.0.0.1" : "0.0.0.0";
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, host, resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    orders,
    idempotencyKeys,
    settle,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
