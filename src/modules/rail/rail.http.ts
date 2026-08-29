import { assertEgressPermitted } from "../../shared/egress-guard.js";
import { paiseToCanonical, type Paise } from "../../shared/money.js";
import {
  RailRejectedError,
  RailTimeoutError,
  type ChargeTokenRequest,
  type CreateMandateOrderRequest,
  type CreateOrderRequest,
  type CreateRefundRequest,
  type RailCharge,
  type RailCustomer,
  type RailToken,
  type PaymentRail,
  type RailMode,
  type RailOrder,
  type RailRefund,
} from "./rail.validation.js";

/**
 * One HTTP client for both rails. Only the base URL and the credential differ, so the
 * replay rail exercises exactly the code the live rail does.
 */

export interface RailHttpOptions {
  readonly mode: RailMode;
  readonly baseUrl: string;
  readonly keyId: string;
  readonly keySecret: string;
  readonly timeoutMs: number;
}

/** How far back a lost-answer recovery looks. Razorpay returns newest first. */
const RECENT_ORDER_WINDOW = 100;

interface RazorpayOrderBody {
  id: string;
  status: string;
  amount: number;
  amount_paid: number;
  notes?: Record<string, string> | unknown[];
  payments?: { items?: Array<{ id: string }> };
}

function toNotes(value: RazorpayOrderBody["notes"]): Record<string, string> {
  // Razorpay returns [] for an empty notes object.
  return value !== undefined && !Array.isArray(value) ? (value as Record<string, string>) : {};
}

function toOrder(body: RazorpayOrderBody): RailOrder {
  const status = ["created", "attempted", "paid", "failed"].includes(body.status)
    ? (body.status as RailOrder["status"])
    : "created";
  return {
    railOrderId: body.id,
    status,
    amountPaise: BigInt(body.amount),
    amountPaidPaise: BigInt(body.amount_paid ?? 0),
    railPaymentId: body.payments?.items?.[0]?.id ?? null,
    notes: toNotes(body.notes),
  };
}

export function createHttpRail(options: RailHttpOptions): PaymentRail {
  const auth = `Basic ${Buffer.from(`${options.keyId}:${options.keySecret}`).toString("base64")}`;

  async function call<T>(
    operation: string,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    // INV-19: refuses if the mandate row lock is held. Any call from inside the
    // authorisation transaction throws here rather than serialising a mandate behind a
    // third party.
    assertEgressPermitted(`${options.baseUrl}${path}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const response = await fetch(`${options.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: auth,
          // INV-04: the same intent replayed produces the same key, so the rail
          // collapses it into one payment.
          ...(idempotencyKey === undefined ? {} : { "X-Razorpay-Idempotency-Key": idempotencyKey }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      const text = await response.text();
      const parsed: unknown = text.length > 0 ? JSON.parse(text) : {};

      if (!response.ok) {
        const error =
          typeof parsed === "object" && parsed !== null && "error" in parsed
            ? (parsed as { error: { code?: string; description?: string } }).error
            : undefined;
        throw new RailRejectedError(
          operation,
          String(error?.code ?? "UNKNOWN"),
          response.status,
          error?.description,
        );
      }

      return parsed as T;
    } catch (error) {
      if (error instanceof RailRejectedError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new RailTimeoutError(operation);
      }
      throw new RailTimeoutError(operation);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    mode: options.mode,

    async createOrder(request: CreateOrderRequest): Promise<RailOrder> {
      const body: Record<string, unknown> = {
        amount: Number(request.amountPaise),
        currency: request.currency,
        notes: request.notes,
      };
      if (request.customerId !== undefined) body.customer_id = request.customerId;
      if (request.tokenId !== undefined) body.token_id = request.tokenId;

      return toOrder(
        await call<RazorpayOrderBody>(
          "orders.create",
          "POST",
          "/v1/orders",
          body,
          request.idempotencyKey,
        ),
      );
    },

    async fetchOrder(railOrderId: string): Promise<RailOrder> {
      return toOrder(
        await call<RazorpayOrderBody>(
          "orders.fetch",
          "GET",
          `/v1/orders/${railOrderId}?expand[]=payments`,
        ),
      );
    },

    async findOrderByIntent(intentId: string): Promise<RailOrder | null> {
      const page = await call<{ items?: RazorpayOrderBody[] }>(
        "orders.list",
        "GET",
        `/v1/orders?count=${RECENT_ORDER_WINDOW}`,
      );

      const matches = (page.items ?? []).filter(
        (item) => toNotes(item.notes).intent_id === intentId,
      );

      // More than one means a duplicate already exists. Return the oldest, which is the
      // one a payment is most likely to have been made against, and let the caller
      // adopt it rather than adding a third.
      return matches.length === 0 ? null : toOrder(matches[matches.length - 1]!);
    },

    async createCustomer(input: {
      name: string;
      email: string;
      contact: string;
    }): Promise<RailCustomer> {
      const body = await call<{ id: string }>("customers.create", "POST", "/v1/customers", {
        ...input,
        // An existing customer is returned rather than refused: consent can be repeated.
        fail_existing: "0",
      });
      return { customerId: body.id };
    },

    async createMandateOrder(request: CreateMandateOrderRequest): Promise<RailOrder> {
      return toOrder(
        await call<RazorpayOrderBody>("orders.mandate", "POST", "/v1/orders", {
          amount: Number(request.amountPaise),
          currency: "INR",
          customer_id: request.customerId,
          method: request.method,
          notes: request.notes,
          token: {
            max_amount: Number(request.maxAmountPaise),
            expire_at: Math.floor(request.expiresAt.getTime() / 1000),
            // The shopper approves a ceiling, not a schedule. Each debit is presented on
            // its own, which is what an agent buying groceries actually does.
            frequency: "as_presented",
          },
        }),
      );
    },

    async findToken(customerId: string): Promise<RailToken | null> {
      const body = await call<{
        items?: Array<{ id: string; method: string; max_amount?: number }>;
      }>("tokens.list", "GET", `/v1/customers/${encodeURIComponent(customerId)}/tokens`);

      const token = (body.items ?? [])[0];
      if (token === undefined) return null;
      return {
        tokenId: token.id,
        method: token.method,
        maxAmountPaise: token.max_amount === undefined ? null : BigInt(token.max_amount),
      };
    },

    async chargeToken(request: ChargeTokenRequest): Promise<RailCharge> {
      // The rail already holds the shopper's contact details — it had to, to register the
      // mandate. Reading them back at charge time means we never store a second copy, and
      // pseudonym_map stays the only thing an erasure has to reach.
      const customer = await call<{ email?: string; contact?: string }>(
        "customers.fetch",
        "GET",
        `/v1/customers/${encodeURIComponent(request.customerId)}`,
      );

      const body = await call<{ id: string; status: string }>(
        "payments.recurring",
        "POST",
        "/v1/payments/create/recurring",
        {
          email: customer.email ?? "",
          contact: customer.contact ?? "",
          amount: Number(request.amountPaise),
          currency: "INR",
          order_id: request.railOrderId,
          customer_id: request.customerId,
          token: request.tokenId,
          recurring: "1",
          description: request.description,
        },
      );
      return { railPaymentId: body.id, status: body.status };
    },

    async createRefund(request: CreateRefundRequest): Promise<RailRefund> {
      const body = await call<{ id: string; status: string; amount: number }>(
        "refunds.create",
        "POST",
        `/v1/payments/${request.railPaymentId}/refund`,
        { amount: Number(request.amountPaise), notes: request.notes },
        request.idempotencyKey,
      );
      const status = ["pending", "processed", "failed"].includes(body.status)
        ? (body.status as RailRefund["status"])
        : "pending";
      return { railRefundId: body.id, status, amountPaise: BigInt(body.amount) };
    },
  };
}

/** Formats paise for a note field without going through a JSON number. */
export function noteAmount(amount: Paise): string {
  return paiseToCanonical(amount);
}
