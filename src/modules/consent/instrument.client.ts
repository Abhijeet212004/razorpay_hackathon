import { assertEgressPermitted } from "../../shared/egress-guard.js";

/**
 * How the kernel arranges a payment instrument without holding a payment credential.
 *
 * Every Razorpay call here happens inside the executor. The kernel only ever learns three
 * opaque strings — a customer id, an order id and a publishable key — none of which can
 * move money on their own.
 */

export interface InstrumentSetup {
  readonly customerId: string;
  readonly railOrderId: string;
  readonly amountPaise: string;
  readonly keyId: string;
}

export interface InstrumentToken {
  readonly tokenId: string;
  readonly method: string;
  readonly maxAmountPaise: string | null;
}

export interface InstrumentClient {
  begin(input: {
    name: string;
    email: string;
    contact: string;
    maxAmountPaise: string;
    amountPaise: string;
    expiresAt: string;
    method: "upi" | "card" | "emandate";
    notes?: Record<string, string>;
  }): Promise<InstrumentSetup>;
  token(customerId: string): Promise<InstrumentToken | null>;
  /** The publishable key, fetched when a page needs it rather than held in this process. */
  publishableKey(): Promise<string>;
}

export function createInstrumentClient(options: {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}): InstrumentClient {
  async function request<T>(path: string, body?: unknown): Promise<T | null> {
    assertEgressPermitted(`${options.baseUrl}${path}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
    try {
      const response = await fetch(`${options.baseUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        signal: controller.signal,
        headers: {
          "X-Executor-Token": options.token,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`executor returned ${response.status}`);
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async begin(input): Promise<InstrumentSetup> {
      const setup = await request<InstrumentSetup>("/mandate/setup", input);
      if (setup === null) throw new Error("executor could not start the mandate setup");
      return setup;
    },
    token: (customerId) =>
      request<InstrumentToken>(`/tokens/${encodeURIComponent(customerId)}`),

    async publishableKey(): Promise<string> {
      const body = await request<{ keyId: string }>("/publishable-key");
      return body?.keyId ?? "";
    },
  };
}
