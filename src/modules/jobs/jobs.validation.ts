/** Timings, in one place, so a drift between the reaper and the reconciler is one diff. */
export const JOB_TIMINGS = {
  /** A hold with no order row is reapable after this. */
  reservationTtlMs: 15 * 60_000,
  reaperIntervalMs: 60_000,
  /** The reconciler gives up here, marks the order unresolved and alerts. */
  reconcileMaxAgeMs: 24 * 60 * 60_000,
  reconcileBackoffMs: [5_000, 15_000, 45_000, 120_000, 300_000, 900_000, 1_800_000],
  challengeTtlMs: 5 * 60_000,
  anchorIntervalMs: 5 * 60_000,
  anchorEveryNAppends: 100,
} as const;

export interface JobResult {
  readonly job: string;
  readonly examined: number;
  readonly changed: number;
  readonly details: readonly string[];
}
