import { z } from "zod";

/** What a merchant tells us about themselves. Every URL is theirs, not ours. */
export const MerchantOnboardingSchema = z.object({
  display_name: z.string().min(1).max(120),
  /** Their existing product endpoint. Read-only; we never write to it. */
  catalog_url: z.string().url(),
  /** Where an agent's paid order becomes a real order in their system. */
  fulfil_url: z.string().url().optional(),
  /** Where they identify a shopper before a grant. See the consent binding. */
  authorize_url: z.string().url().optional(),
  /** Their own origin, used to build links a shopper will click. */
  public_base_url: z.string().url(),
});

export type MerchantOnboarding = z.infer<typeof MerchantOnboardingSchema>;

export const MerchantConfigSchema = MerchantOnboardingSchema.partial();
export type MerchantConfigUpdate = z.infer<typeof MerchantConfigSchema>;

export interface MerchantRecord {
  readonly merchantId: string;
  readonly displayName: string;
  readonly catalogUrl: string | null;
  readonly fulfilUrl: string | null;
  readonly authorizeUrl: string | null;
  readonly publicBaseUrl: string | null;
  readonly state: "active" | "suspended";
}

/**
 * Returned once, at onboarding, and never again.
 *
 * Only hashes are stored, so these cannot be recovered — losing them means rotating, not
 * looking them up. That is the point: a dump of the merchants table yields no working
 * credential.
 */
export interface MerchantCredentials {
  readonly merchantId: string;
  /** Presented by agents on every call. Decides whose limits apply. */
  readonly apiKey: string;
  /** Presented by the merchant's own backend for server-to-server calls. */
  readonly fulfilToken: string;
}

export type ResolveOutcome =
  | { kind: "RESOLVED"; merchantId: string }
  | { kind: "SUSPENDED"; merchantId: string }
  | { kind: "UNKNOWN" };
