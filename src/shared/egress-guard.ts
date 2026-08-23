import { AsyncLocalStorage } from "node:async_hooks";

/**
 * INV-19: no outbound call while the mandate row lock is held.
 *
 * A slow third-party call inside the lock serialises every purchase on that mandate
 * behind an API we do not control. The authorisation service runs its locked section
 * inside withMandateLockHeld; every HTTP client calls assertEgressPermitted before
 * opening a socket. A call site can forget to check, but it cannot opt out of the flag.
 */

interface LockContext {
  readonly mandateId: string;
}

const lockStorage = new AsyncLocalStorage<LockContext>();

export class EgressUnderLockError extends Error {
  constructor(
    readonly mandateId: string,
    readonly destination: string,
  ) {
    super(
      `attempted egress to ${destination} while holding the row lock on mandate ` +
        `${mandateId}. Move the call before BEGIN or after COMMIT.`,
    );
    this.name = "EgressUnderLockError";
  }
}

export function withMandateLockHeld<T>(mandateId: string, fn: () => Promise<T>): Promise<T> {
  return lockStorage.run({ mandateId }, fn);
}

export function isMandateLockHeld(): boolean {
  return lockStorage.getStore() !== undefined;
}

export function assertEgressPermitted(destination: string): void {
  const context = lockStorage.getStore();
  if (context !== undefined) {
    throw new EgressUnderLockError(context.mandateId, destination);
  }
}
