/**
 * INV-12: untrusted content is never instruction and never reaches a decision-bearing
 * field.
 *
 * Branded types separating content that came from outside from content the kernel
 * produced. A Tainted<T> cannot be assigned where Trusted<T> is required, so untrusted
 * text cannot reach a field a decision reads.
 */

declare const TAINT: unique symbol;
declare const TRUST: unique symbol;

export type Tainted<T> = T & { readonly [TAINT]: "tainted" };
export type Trusted<T> = T & { readonly [TRUST]: "trusted" };

/** Applied at the HTTP edge, before anything reaches a model or a rule. */
export function taint<T>(value: T): Tainted<T> {
  return value as Tainted<T>;
}

/** Applied to kernel-produced or signature-verified values. */
export function trust<T>(value: T): Trusted<T> {
  return value as Trusted<T>;
}

/** Render-only. The result must not reach a decision-bearing field. */
export function untaintForDisplay<T>(value: Tainted<T>): T {
  return value as T;
}

/** Persistence-only, for writing tainted content into a redacted ledger payload. */
export function untaintForStorage<T>(value: Tainted<T>): T {
  return value as T;
}
