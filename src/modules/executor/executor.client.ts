import { assertEgressPermitted } from "../../shared/egress-guard.js";
import type {
  ExecuteRequest,
  ExecuteResult,
  ExecutorClient,
  RefundRequest,
  RefundResult,
} from "./executor.validation.js";

/**
 * How the kernel and worker reach the executor: over the internal network, with a shared
 * token. Neither holds a payment credential, so neither can do this itself.
 */
export function createExecutorHttpClient(options: {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}): ExecutorClient {
  async function post<T>(path: string, body: unknown): Promise<T> {
    assertEgressPermitted(`${options.baseUrl}${path}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
    try {
      const response = await fetch(`${options.baseUrl}${path}`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", "X-Executor-Token": options.token },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`executor returned ${response.status}`);
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async execute(request: ExecuteRequest): Promise<ExecuteResult> {
      return post<ExecuteResult>("/execute", {
        ...request,
        amountPaise: request.amountPaise.toString(),
      });
    },
    async refund(request: RefundRequest): Promise<RefundResult> {
      return post<RefundResult>("/refund", {
        ...request,
        amountPaise: request.amountPaise.toString(),
      });
    },
  };
}
