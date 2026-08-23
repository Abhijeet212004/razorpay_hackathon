/**
 * The kernel's log sink and counters.
 *
 * Unexpected errors must be distinguishable in metrics from known dependency failures:
 * both deny with SYS-001, but only one of them is a bug.
 */
export interface Logger {
  error(message: string, error?: unknown): void;
  warn(message: string, detail?: unknown): void;
  /** Incremented by name so an unexpected SYS-001 has its own series. */
  count(metric: string): void;
}

export const consoleLogger: Logger = {
  error(message, error) {
    console.error(`[agentkit] ${message}`, error instanceof Error ? error.stack : error);
  },
  warn(message, detail) {
    console.warn(`[agentkit] ${message}`, detail);
  },
  count(metric) {
    console.error(`[agentkit.metric] ${metric}`);
  },
};

export const silentLogger: Logger = {
  error: () => undefined,
  warn: () => undefined,
  count: () => undefined,
};

/** The constructor name, which is safe to store. Messages carry PII; classes do not. */
export function errorClass(error: unknown): string {
  if (error instanceof Error) return error.constructor.name;
  return typeof error;
}
