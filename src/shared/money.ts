import { z } from "zod";

/** Money is BIGINT paise. In signed payloads it is a decimal string, never a JSON number. */
export const PaiseSchema = z
  .union([z.bigint(), z.string().regex(/^(0|[1-9][0-9]*)$/)])
  .transform((value) => (typeof value === "bigint" ? value : BigInt(value)))
  .refine((value) => value >= 0n, { message: "amount must not be negative" });

export type Paise = bigint;

export const RUPEE = 100n;

export function paiseToCanonical(value: Paise): string {
  return value.toString(10);
}

export function rupees(amount: number): Paise {
  if (!Number.isInteger(amount)) {
    throw new Error(`rupees() takes whole rupees, received ${amount}`);
  }
  return BigInt(amount) * RUPEE;
}
