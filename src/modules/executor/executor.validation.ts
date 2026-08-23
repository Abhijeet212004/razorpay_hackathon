import type { Paise } from "../../shared/money.js";

export type OrderState =
  | "AUTHORISED"
  | "SUBMITTED"
  | "CAPTURED"
  | "FAILED"
  | "AMBIGUOUS"
  | "FAILED_UNRESOLVED";

export interface ExecuteRequest {
  readonly intentId: string;
  readonly mandateId: string;
  readonly merchantId: string;
  readonly amountPaise: Paise;
  readonly decisionId: string;
}

export interface ExecuteResult {
  readonly orderId: string;
  readonly state: OrderState;
  readonly railOrderId: string | null;
  readonly idempotencyKey: string;
}

export interface RefundRequest {
  readonly orderId: string;
  readonly merchantId: string;
  readonly amountPaise: Paise;
  readonly reason: string;
}

export interface RefundResult {
  readonly refundId: string;
  readonly state: "REQUESTED" | "SUBMITTED" | "COMPLETED" | "FAILED";
  readonly railRefundId: string | null;
}

/**
 * What the kernel and the worker are allowed to ask the executor for.
 *
 * In deployment this is an HTTP call to a service with no public ingress, holding the
 * only payment credential in the system. The interface exists so that neither caller
 * needs the credential to express what it wants done.
 */
export interface ExecutorClient {
  execute(request: ExecuteRequest): Promise<ExecuteResult>;
  refund(request: RefundRequest): Promise<RefundResult>;
}
