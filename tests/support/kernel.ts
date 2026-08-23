import type { Pool } from "pg";
import {
  DEFAULT_KERNEL_CONFIG,
  type KernelContext,
} from "../../src/modules/authorization/authorization.service.js";
import type { Clock } from "../../src/shared/clock.js";
import type {
  BlindVerifier,
  VerifierOutcome,
} from "../../src/modules/verifier/verifier.validation.js";
import { createExecutor } from "../../src/modules/executor/executor.service.js";
import { createHttpRail } from "../../src/modules/rail/rail.http.js";
import type { ExecutorClient } from "../../src/modules/executor/executor.validation.js";
import { startReplayRail, type ReplayRail } from "../../src/services/replay/replay.server.js";

export const TEST_WEBHOOK_SECRET = "whsec_test_only";

export interface TestRail {
  readonly replay: ReplayRail;
  readonly executor: ExecutorClient;
  close(): Promise<void>;
}

/**
 * A real HTTP rail on a real socket, serving recorded shapes. The executor's client,
 * idempotency header, error mapping and timeouts all genuinely run against it.
 */
export async function startTestRail(
  pool: Pool,
  options: { webhookUrl?: string; settleAfterMs?: number; goSilent?: boolean; failPayments?: boolean } = {},
): Promise<TestRail> {
  const replay = await startReplayRail({ webhookSecret: TEST_WEBHOOK_SECRET, ...options });
  const rail = createHttpRail({
    mode: "replay",
    baseUrl: replay.url,
    keyId: "rzp_test_replay",
    keySecret: "replay-has-no-real-secret",
    timeoutMs: 2_000,
  });
  return {
    replay,
    executor: createExecutor({ pool, rail }),
    close: () => replay.close(),
  };
}

/**
 * A verifier that raises no objection. PROCEED is not a grant — the outcome type has no
 * ALLOW — so this double cannot make an intent pass anything. Every check from the
 * mandate lock onward still runs, which keeps these suites measuring the kernel rather
 * than the verifier's heuristics.
 */
export function noObjectionVerifier(): BlindVerifier {
  return {
    assess: (): Promise<VerifierOutcome> => Promise.resolve({ kind: "PROCEED" }),
  };
}

/** A verifier that is always down. Unavailability must never grant. */
export function unavailableVerifier(): BlindVerifier {
  return {
    assess: (): Promise<VerifierOutcome> =>
      Promise.resolve({ kind: "UNAVAILABLE", detail: "test double" }),
  };
}

export function fixedClock(at: Date): Clock {
  return { now: () => new Date(at) };
}

export function testKernel(
  pool: Pool,
  merchantId: string,
  overrides: Partial<KernelContext> = {},
): KernelContext {
  return {
    pool,
    verifier: noObjectionVerifier(),
    clock: { now: () => new Date() },
    config: { ...DEFAULT_KERNEL_CONFIG, merchantId },
    ...overrides,
  };
}
