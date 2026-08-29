import { z } from "zod";

export const RequestConsentSchema = z.object({
  agent_id: z.string().min(1),
  /**
   * The merchant's own id for the shopper, and for the address they chose. Supplied by
   * the merchant's own server, which knows who is logged in — never by the agent.
   */
  customer_ref: z.string().min(1).max(120).optional(),
  fulfilment_ref: z.string().min(1).max(120).optional(),
  contact: z.string().regex(/^\+?[0-9]{10,15}$/),
  requested_scope: z.object({
    merchants: z.array(z.string().min(1)).min(1),
    categories: z.array(z.string().min(1)).min(1),
    currency: z.literal("INR"),
  }),
  limits: z.object({
    per_transaction_paise: z.string().regex(/^(0|[1-9][0-9]*)$/),
    cumulative_paise: z.string().regex(/^(0|[1-9][0-9]*)$/),
    silent_threshold_paise: z.string().regex(/^(0|[1-9][0-9]*)$/),
    velocity_per_hour: z.number().int().positive().max(100),
  }),
});

export type RequestConsentInput = z.infer<typeof RequestConsentSchema>;

export const VerifyOtpSchema = z.object({
  code: z.string().regex(/^[0-9]{6}$/),
});

export interface ConsentRequestView {
  readonly requestRef: string;
  readonly agentName: string;
  readonly merchantName: string;
  readonly state: string;
  readonly categories: readonly string[];
  readonly perTransactionPaise: bigint;
  readonly cumulativePaise: bigint;
  readonly silentThresholdPaise: bigint;
  readonly velocityPerHour: number;
  readonly contactMasked: string;
}
