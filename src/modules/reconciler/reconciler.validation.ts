import { z } from "zod";

/**
 * A webhook proves origin, not truth. The signature says Razorpay sent it; only
 * orders.fetch says what actually happened.
 */
export const WebhookEnvelopeSchema = z.object({
  entity: z.literal("event"),
  event: z.string().min(1),
  id: z.string().min(1),
  created_at: z.number().int(),
  payload: z.object({
    payment: z
      .object({
        entity: z.object({
          id: z.string().min(1),
          order_id: z.string().min(1),
          status: z.string().min(1),
        }),
      })
      .optional(),
  }),
});

export type WebhookEnvelope = z.infer<typeof WebhookEnvelopeSchema>;

export type IngestOutcome =
  | {
      readonly kind: "APPLIED";
      readonly orderId: string;
      readonly intentId: string;
      readonly state: string;
    }
  | { readonly kind: "DUPLICATE"; readonly providerEventId: string }
  | { readonly kind: "UNVERIFIED" }
  | { readonly kind: "MALFORMED" }
  | { readonly kind: "UNKNOWN_ORDER"; readonly railOrderId: string };
