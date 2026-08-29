import { assertEgressPermitted } from "../../shared/egress-guard.js";
import type {
  ChargeTokenRequest,
  CreateMandateOrderRequest,
  CreateOrderRequest,
  CreateRefundRequest,
  RailCharge,
  RailCustomer,
  RailToken,
  PaymentRail,
  RailMode,
  RailOrder,
  RailRefund,
} from "./rail.validation.js";

/**
 * INV-02: a rail that can read and cannot pay.
 *
 * The kernel and worker need provider truth — a webhook payload is never trusted on its
 * own — but reading it requires an authenticated call, and Razorpay issues no read-only
 * key: one key pair per account, and it can charge. Handing that to the kernel to satisfy
 * a read would put a payment credential in the process with public ingress.
 *
 * So the read goes through the executor, which already holds the credential and already
 * takes authenticated internal calls. What comes back here is the same RailOrder the HTTP
 * rail returns, so callers cannot tell the difference — except that createOrder and
 * createRefund throw. They are not unimplemented; they are absent by construction.
 */

export class RailIsReadOnlyError extends Error {
  constructor(readonly operation: string) {
    super(
      `${operation} is not available on a read-only rail. Only the executor service holds ` +
        "a payment credential; route this through it rather than widening the rail.",
    );
    this.name = "RailIsReadOnlyError";
  }
}

interface WireOrder {
  railOrderId: string;
  status: RailOrder["status"];
  amountPaise: string;
  amountPaidPaise: string;
  railPaymentId: string | null;
  notes: Record<string, string>;
}

function fromWire(wire: WireOrder): RailOrder {
  return {
    railOrderId: wire.railOrderId,
    status: wire.status,
    amountPaise: BigInt(wire.amountPaise),
    amountPaidPaise: BigInt(wire.amountPaidPaise),
    railPaymentId: wire.railPaymentId,
    notes: wire.notes,
  };
}

export function createExecutorReadRail(options: {
  mode: RailMode;
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}): PaymentRail {
  async function get<T>(path: string): Promise<T | null> {
    assertEgressPermitted(`${options.baseUrl}${path}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
    try {
      const response = await fetch(`${options.baseUrl}${path}`, {
        signal: controller.signal,
        headers: { "X-Executor-Token": options.token },
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`executor returned ${response.status}`);
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    mode: options.mode,

    async fetchOrder(railOrderId: string): Promise<RailOrder> {
      const wire = await get<WireOrder>(`/orders/${encodeURIComponent(railOrderId)}`);
      if (wire === null) throw new Error(`rail has no order ${railOrderId}`);
      return fromWire(wire);
    },

    async findOrderByIntent(intentId: string): Promise<RailOrder | null> {
      const wire = await get<WireOrder>(
        `/orders/by-intent/${encodeURIComponent(intentId)}`,
      );
      return wire === null ? null : fromWire(wire);
    },

    async findToken(customerId: string): Promise<RailToken | null> {
      const wire = await get<{ tokenId: string; method: string; maxAmountPaise: string | null }>(
        `/tokens/${encodeURIComponent(customerId)}`,
      );
      if (wire === null) return null;
      return {
        tokenId: wire.tokenId,
        method: wire.method,
        maxAmountPaise: wire.maxAmountPaise === null ? null : BigInt(wire.maxAmountPaise),
      };
    },

    // Everything below moves money, or sets up the means to. None of it is reachable from
    // a process without a payment credential, which is the entire point of this class.
    createOrder(_request: CreateOrderRequest): Promise<RailOrder> {
      return Promise.reject(new RailIsReadOnlyError("createOrder"));
    },

    createRefund(_request: CreateRefundRequest): Promise<RailRefund> {
      return Promise.reject(new RailIsReadOnlyError("createRefund"));
    },

    createCustomer(_input: {
      name: string;
      email: string;
      contact: string;
    }): Promise<RailCustomer> {
      return Promise.reject(new RailIsReadOnlyError("createCustomer"));
    },

    createMandateOrder(_request: CreateMandateOrderRequest): Promise<RailOrder> {
      return Promise.reject(new RailIsReadOnlyError("createMandateOrder"));
    },

    chargeToken(_request: ChargeTokenRequest): Promise<RailCharge> {
      return Promise.reject(new RailIsReadOnlyError("chargeToken"));
    },
  };
}
