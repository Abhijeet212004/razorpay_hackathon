/**
 * The public record of one decision.
 *
 * Shaped for a person reading it rather than for a machine replaying it: what happened,
 * in order, with the hash that fixes each entry in the chain.
 */

export interface AuditEntry {
  /** INTENT, DECISION, RESERVATION, EXECUTION_RESULT, RELEASE, and so on. */
  readonly kind: string;
  readonly seq: number;
  /** Hex. Each entry commits to the one before it, so a removed entry breaks the chain. */
  readonly hash: string;
  readonly prev_hash: string;
  readonly at: string;
  readonly detail: unknown;
}

export interface AuditRecord {
  readonly intent_id: string;
  readonly entries: readonly AuditEntry[];
  /** False if any entry does not commit to its predecessor. */
  readonly chain_intact: boolean;
}
