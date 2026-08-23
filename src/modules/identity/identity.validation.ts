import { z } from "zod";

export const RegisterAgentSchema = z.object({
  name: z.string().min(1).max(200),
  /** Ed25519, raw 32 bytes, hex encoded. */
  public_key: z.string().regex(/^[0-9a-f]{64}$/),
});

export type RegisterAgentInput = z.infer<typeof RegisterAgentSchema>;

export const AUTH_METHODS = ["sms_otp", "upi_pin"] as const;
export const AuthMethodSchema = z.enum(AUTH_METHODS);
export type AuthMethod = z.infer<typeof AuthMethodSchema>;

export const RecordAuthEventSchema = z.object({
  subject_pseudonym: z.string().min(1),
  method: AuthMethodSchema,
  /** Freshness bound applied when granting, widening or stepping up. */
  max_age_seconds: z.number().int().positive().max(3600),
});

export type RecordAuthEventInput = z.infer<typeof RecordAuthEventSchema>;

export const KEY_PURPOSES = ["mandate", "quote", "catalog", "anchor"] as const;
export const KeyPurposeSchema = z.enum(KEY_PURPOSES);
export type KeyPurpose = z.infer<typeof KeyPurposeSchema>;
