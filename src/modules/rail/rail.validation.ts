import type { Paise } from "../../shared/money.js";

/**
 * The payment rail, as the executor sees it.
 *
 * Both adapters speak this and nothing else. The replay adapter is a real HTTP client
 * against a real HTTP server, so the executor's socket handling, idempotency headers,
 * error mapping and timeout behaviour all genuinely run — unlike in-process mocking,
 * where none of that code executes.
 */

export type RailMode = "replay" | "razorpay";

export interface CreateOrderRequest {
  readonly amountPaise: Paise;
  readonly currency: "INR";
  readonly idempotencyKey: string;
  /** Carries intent_id, so an order in the Razorpay dashboard joins back to our ledger. */
  readonly notes: Readonly<Record<string, string>>;
  readonly customerId?: string;
  readonly tokenId?: string;
}

export interface RailOrder {
  readonly railOrderId: string;
  readonly status: "created" | "attempted" | "paid" | "failed";
  readonly amountPaise: Paise;
  readonly amountPaidPaise: Paise;
  readonly railPaymentId: string | null;
  readonly notes: Readonly<Record<string, string>>;
}

export interface CreateRefundRequest {
  readonly railPaymentId: string;
  readonly amountPaise: Paise;
  readonly idempotencyKey: string;
  readonly notes: Readonly<Record<string, string>>;
}

export interface RailRefund {
  readonly railRefundId: string;
  readonly status: "pending" | "processed" | "failed";
  readonly amountPaise: Paise;
}

/** The rail did not answer. It is never safe to assume which side of it the money is on. */
export class RailTimeoutError extends Error {
  constructor(readonly operation: string) {
    super(`rail did not respond to ${operation}`);
    this.name = "RailTimeoutError";
  }
}

export class RailRejectedError extends Error {
  constructor(
    readonly operation: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(`rail rejected ${operation}: ${code}`);
    this.name = "RailRejectedError";
  }
}

export interface PaymentRail {
  readonly mode: RailMode;
  createOrder(request: CreateOrderRequest): Promise<RailOrder>;
  /** Re-reads current truth. Ambiguity is resolved by reading, never by retrying. */
  fetchOrder(railOrderId: string): Promise<RailOrder>;
  createRefund(request: CreateRefundRequest): Promise<RailRefund>;
}
