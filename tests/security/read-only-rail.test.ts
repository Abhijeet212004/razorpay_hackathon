import { describe, expect, it } from "vitest";
import {
  createExecutorReadRail,
  RailIsReadOnlyError,
} from "../../src/modules/rail/rail.proxy.js";
import {
  findPaymentCredentials,
  assertNoPaymentCredential,
} from "../../src/shared/credentials.js";

/**
 * INV-02. The kernel has public ingress and must never be able to move money, but it does
 * need provider truth to reconcile. Razorpay issues no read-only key, so the read goes
 * through the executor instead of a second credential.
 */

const rail = createExecutorReadRail({
  mode: "razorpay",
  baseUrl: "http://executor.invalid:8081",
  token: "t",
});

describe("the rail the kernel gets", () => {
  it("cannot create an order", async () => {
    await expect(
      rail.createOrder({
        amountPaise: 100n,
        currency: "INR",
        idempotencyKey: "k",
        notes: {},
      }),
    ).rejects.toBeInstanceOf(RailIsReadOnlyError);
  });

  it("cannot create a refund", async () => {
    await expect(
      rail.createRefund({ railPaymentId: "pay_x", amountPaise: 100n, idempotencyKey: "k", notes: {} }),
    ).rejects.toBeInstanceOf(RailIsReadOnlyError);
  });

  it("still satisfies the rail interface, so callers cannot tell it apart", () => {
    expect(typeof rail.fetchOrder).toBe("function");
    expect(typeof rail.findOrderByIntent).toBe("function");
  });
});

describe("a read credential is still a credential", () => {
  it.each(["RZP_READ_KEY_ID", "RZP_READ_KEY_SECRET"])(
    "%s counts, because Razorpay has no read-only key",
    (variable) => {
      expect(findPaymentCredentials({ [variable]: "rzp_test_x" })).toContain(variable);
      expect(() => assertNoPaymentCredential("kernel", { [variable]: "rzp_test_x" })).toThrow();
    },
  );

  it("lets the kernel boot when it holds neither", () => {
    expect(() =>
      assertNoPaymentCredential("kernel", { RAIL: "razorpay", EXECUTOR_TOKEN: "t" }),
    ).not.toThrow();
  });
});
