import { NotImplementedError } from "../../shared/errors.js";
import type { KernelContext } from "./authorization.service.js";
import type { Decision } from "./authorization.validation.js";

/**
 * Validates the request body, tags outside content as tainted, calls the service, and
 * shapes the response. The controller never decides anything.
 */
export function confirmPurchase(_ctx: KernelContext, _body: unknown): Promise<Decision> {
  throw new NotImplementedError("authorization.controller.confirmPurchase", "Phase 4");
}

/** ACP-shaped entry point for buyers that do not speak MCP. Same service, same gate. */
export function acpCheckout(_ctx: KernelContext, _body: unknown): Promise<Decision> {
  throw new NotImplementedError("authorization.controller.acpCheckout", "Phase 4");
}

/** Renders the step-up approval page from server state and applies the approval. */
export function approve(_ctx: KernelContext, _challengeId: string): Promise<Decision> {
  throw new NotImplementedError("authorization.controller.approve", "Phase 4");
}
