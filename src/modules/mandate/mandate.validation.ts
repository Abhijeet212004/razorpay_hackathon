import { z } from "zod";
import { PaiseSchema } from "../../shared/money.js";

export const MandateScopeSchema = z.object({
  merchants: z.array(z.string().min(1)).min(1),
  categories: z.array(z.string().min(1)).min(1),
  currency: z.literal("INR"),
});

export const MandateLimitsSchema = z.object({
  per_transaction_paise: PaiseSchema,
  cumulative_paise: PaiseSchema,
  cumulative_window: z.string().min(1),
  velocity_per_hour: z.number().int().nonnegative(),
  silent_threshold_paise: PaiseSchema,
});

export const IssueMandateSchema = z.object({
  merchant_id: z.string().min(1),
  subject_pseudonym: z.string().min(1),
  agent_id: z.string().min(1),
  /** A mandate binds a fresh authentication event. Ambient session state is not consent. */
  auth_event_id: z.string().min(1),
  scope: MandateScopeSchema,
  limits: MandateLimitsSchema,
  not_before: z.string().datetime({ offset: true }),
  not_after: z.string().datetime({ offset: true }),
  /**
   * The merchant's own ids for the shopper and their chosen delivery address. Captured at
   * consent, when a human is present and the merchant knows who is logged in. The agent
   * never supplies either, and cannot change them afterwards.
   */
  customer_ref: z.string().min(1).max(120).optional(),
  fulfilment_ref: z.string().min(1).max(120).optional(),
});

export type IssueMandateInput = z.infer<typeof IssueMandateSchema>;

export const RevokeMandateSchema = z.object({
  mandate_id: z.string().min(1),
  reason: z.string().max(500),
});

export type RevokeMandateInput = z.infer<typeof RevokeMandateSchema>;

export interface RevocationResult {
  readonly mandateId: string;
  readonly alreadyRevoked: boolean;
  /**
   * Reservations still held when revocation landed. The money may already be in flight;
   * these are compensated by refund rather than pretended away.
   */
  readonly heldReservationIds: readonly string[];
  /** Null when the mandate was already revoked and nothing new was appended. */
  readonly ledgerSeq: number | null;
}
