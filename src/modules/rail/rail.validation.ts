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
    /** What the rail actually said. A bare code sends you probing the API by hand. */
    readonly description?: string,
  ) {
    super(
      `rail rejected ${operation}: ${code}` +
        (description === undefined ? "" : ` — ${description}`),
    );
    this.name = "RailRejectedError";
  }
}

/**
 * Setting up an instrument the shopper's bank has agreed may be charged while they are
 * absent. This happens once, at consent, and only ever with the shopper present.
 */
export interface CreateMandateOrderRequest {
  readonly customerId: string;
  /** The ceiling the bank records. Our own limits are enforced separately and are lower. */
  readonly maxAmountPaise: Paise;
  readonly expiresAt: Date;
  readonly method: "upi" | "card" | "emandate";
  /** What is debited to register the mandate. Often the smallest unit the rail allows. */
  readonly amountPaise: Paise;
  readonly notes: Readonly<Record<string, string>>;
}

export interface RailCustomer {
  readonly customerId: string;
}

export interface RailToken {
  readonly tokenId: string;
  readonly method: string;
  readonly maxAmountPaise: Paise | null;
}

/** Charging an instrument with nobody watching. The whole point of the setup above. */
export interface ChargeTokenRequest {
  readonly customerId: string;
  readonly tokenId: string;
  readonly railOrderId: string;
  readonly amountPaise: Paise;
  readonly description: string;
}

export interface RailCharge {
  readonly railPaymentId: string;
  readonly status: string;
}

export interface PaymentRail {
  readonly mode: RailMode;
  createOrder(request: CreateOrderRequest): Promise<RailOrder>;
  /** Re-reads current truth. Ambiguity is resolved by reading, never by retrying. */
  fetchOrder(railOrderId: string): Promise<RailOrder>;
  /**
   * Finds an order by the intent that created it, without creating one.
   *
   * This is the read used when a call was made but the answer was lost, so no rail order
   * id was ever stored. Razorpay's Orders API honours neither an idempotency key nor a
   * unique receipt — both were measured creating duplicates — so re-issuing the create
   * is not a read. Searching the notes is.
   *
   * Bounded to recent orders: it recovers a call made minutes ago, not months.
   */
  findOrderByIntent(intentId: string): Promise<RailOrder | null>;
  createRefund(request: CreateRefundRequest): Promise<RailRefund>;

  /** The rail's handle for a shopper. Created once, at consent. */
  createCustomer(input: {
    name: string;
    email: string;
    contact: string;
  }): Promise<RailCustomer>;

  /** The order the shopper authorises to register a mandate with their bank. */
  createMandateOrder(request: CreateMandateOrderRequest): Promise<RailOrder>;

  /** What the bank gave back, once the shopper approved. Null until they have. */
  findToken(customerId: string): Promise<RailToken | null>;

  /** Debits an authorised instrument. No shopper, no PIN, no screen. */
  chargeToken(request: ChargeTokenRequest): Promise<RailCharge>;
}
