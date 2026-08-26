import { z } from "zod";

export const OrderHistorySchema = z.object({
  mandate_id: z.string().min(1),
  limit: z.number().int().positive().max(50).optional(),
});

export const OrderStatusSchema = z.object({
  intent_id: z.string().min(1),
});

export const ReorderSchema = z.object({
  mandate_id: z.string().min(1),
  intent_id: z.string().min(1),
});

export const CancelSchema = z.object({
  mandate_id: z.string().min(1),
  intent_id: z.string().min(1),
});

/**
 * What an agent is told about an order.
 *
 * Deliberately coarse. `SUBMITTING` and `AMBIGUOUS` are both reported as `processing`,
 * because the honest answer is that we do not yet know whether the money moved — and an
 * agent that could distinguish them would be tempted to retry the ambiguous one.
 */
export type AgentOrderState = "authorised" | "processing" | "completed" | "failed";

export interface OrderView {
  readonly intent_id: string;
  readonly state: AgentOrderState;
  readonly amount_paise: string;
  readonly placed_at: string;
  readonly settled_at: string | null;
  readonly items: readonly { sku: string; quantity: number }[];
  /** True while the outcome is genuinely unknown and being reconciled by reading. */
  readonly reconciling: boolean;
}

export type CancelOutcome =
  | { readonly kind: "CANCELLED"; readonly intentId: string }
  | { readonly kind: "TOO_LATE"; readonly reason: string }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "NOT_PERMITTED"; readonly reason: string };
