/**
 * INV-02: only the executor service may hold a payment credential.
 *
 * Called at the top of every other entrypoint — kernel, worker, web, buyer agent. A
 * credential that is merely unused is still a credential, so this refuses to boot.
 */

export const PAYMENT_CREDENTIAL_ENV_VARS = [
  "RZP_KEY_SECRET",
  "RZP_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_KEY_ID",
] as const;

export class PaymentCredentialPresentError extends Error {
  constructor(
    readonly processName: string,
    readonly variables: readonly string[],
  ) {
    super(
      `${processName} must not hold a payment credential, but its environment contains ` +
        `${variables.join(", ")}. Only the executor service may. Remove it from this ` +
        "service's environment rather than leaving it unread.",
    );
    this.name = "PaymentCredentialPresentError";
  }
}

export function findPaymentCredentials(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  return PAYMENT_CREDENTIAL_ENV_VARS.filter((name) => {
    const value = env[name];
    return typeof value === "string" && value.length > 0;
  });
}

export function assertNoPaymentCredential(
  processName: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const found = findPaymentCredentials(env);
  if (found.length > 0) {
    throw new PaymentCredentialPresentError(processName, found);
  }
}
