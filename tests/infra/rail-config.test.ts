import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/shared/config.js";

/**
 * The rail switch has to mean what it says. RAIL=razorpay pointed at a recorded rail
 * would let the kernel settle an intent — and write it to the ledger — for money that
 * never moved.
 */

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
});

function envFor(rail: string, baseUrl?: string): void {
  process.env.RAIL = rail;
  process.env.MERCHANT_ID = "mch_test";
  process.env.WEBHOOK_SECRET = "whsec_test";
  process.env.EXECUTOR_URL = "http://executor:8081";
  process.env.EXECUTOR_TOKEN = "token";
  process.env.PUBLIC_BASE_URL = "http://localhost:8080";
  if (baseUrl === undefined) delete process.env.RAIL_BASE_URL;
  else process.env.RAIL_BASE_URL = baseUrl;
}

describe("rail base URL", () => {
  it("defaults to Razorpay when the rail is razorpay", () => {
    envFor("razorpay");
    expect(loadConfig().railBaseUrl).toBe("https://api.razorpay.com");
  });

  it("treats an empty override as unset rather than as an empty URL", () => {
    envFor("razorpay", "");
    expect(loadConfig().railBaseUrl).toBe("https://api.razorpay.com");
  });

  it("defaults to the replay service when the rail is replay", () => {
    envFor("replay");
    expect(loadConfig().railBaseUrl).toBe("http://replay:8090");
  });

  it("still lets the replay rail be pointed anywhere", () => {
    envFor("replay", "http://localhost:9999");
    expect(loadConfig().railBaseUrl).toBe("http://localhost:9999");
  });

  it("refuses a razorpay rail pointed at the replay service", () => {
    envFor("razorpay", "http://replay:8090");
    expect(() => loadConfig()).toThrow(/requires api\.razorpay\.com/);
  });

  it("refuses a razorpay rail pointed at an attacker's host", () => {
    envFor("razorpay", "https://api.razorpay.com.evil.test");
    expect(() => loadConfig()).toThrow(/requires api\.razorpay\.com/);
  });
});
