import { Pool } from "./db/pg.js";
import { ROLES, type RoleName } from "./db/roles.js";

/** Every runtime switch, read once, in one place. */
export interface RuntimeConfig {
  readonly rail: "replay" | "razorpay";
  readonly brain: "scripted" | "claude";
  readonly verifier: "scripted" | "claude" | "off";
  readonly merchantId: string;
  readonly railBaseUrl: string;
  readonly webhookSecret: string;
  readonly executorUrl: string;
  readonly executorToken: string;
  readonly publicBaseUrl: string;
  /**
   * Where the merchant identifies the shopper before they approve.
   *
   * The kernel serves the consent screen but cannot see who is approving — different
   * origin, different session. Sending them via the merchant first is what lets the
   * grant be bound to a real customer and a real address. Unset means a merchant with no
   * such surface, and consent still works; the mandate simply cannot be fulfilled
   * against their systems.
   */
  readonly merchantAuthorizeUrl: string | null;
}

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`${name} is not set`);
  return value;
}

/**
 * The rail base URL. An empty override counts as unset so a blank compose default falls
 * through to the right rail rather than producing an empty URL.
 *
 * RAIL=razorpay pointed at anything but Razorpay is refused: the kernel would record a
 * settled payment for money that never moved.
 */
function resolveRailBaseUrl(rail: RuntimeConfig["rail"]): string {
  const override = process.env.RAIL_BASE_URL?.trim();
  if (override === undefined || override === "") {
    return rail === "razorpay" ? "https://api.razorpay.com" : "http://replay:8090";
  }
  if (rail === "razorpay" && new URL(override).hostname !== "api.razorpay.com") {
    throw new Error(
      `RAIL=razorpay requires api.razorpay.com, got ${override}. A recorded rail cannot ` +
        `settle real money.`,
    );
  }
  return override;
}

export function loadConfig(): RuntimeConfig {
  const rail = (process.env.RAIL ?? "replay") as RuntimeConfig["rail"];
  const verifier = (process.env.VERIFIER ?? "scripted") as RuntimeConfig["verifier"];

  // `off` skips a downgrade-only stage entirely, which is defensible only when nothing
  // real is at stake.
  if (verifier === "off" && rail !== "replay") {
    throw new Error("VERIFIER=off is permitted only with RAIL=replay");
  }

  return {
    rail,
    brain: (process.env.BRAIN ?? "scripted") as RuntimeConfig["brain"],
    verifier,
    merchantId: required("MERCHANT_ID", "mch_sharma_kirana"),
    railBaseUrl: resolveRailBaseUrl(rail),
    webhookSecret: required("WEBHOOK_SECRET", "whsec_replay_dev_only"),
    executorUrl: required("EXECUTOR_URL", "http://executor:8081"),
    executorToken: required("EXECUTOR_TOKEN", "executor-dev-token"),
    publicBaseUrl: required("PUBLIC_BASE_URL", "http://localhost:8080"),
    merchantAuthorizeUrl: process.env.MERCHANT_AUTHORIZE_URL?.trim() || null,
  };
}

export function poolFor(role: RoleName): Pool {
  const suffix = role.replace(/^agentkit_/, "").toUpperCase();
  return new Pool({
    host: process.env.PGHOST ?? "postgres",
    port: Number(process.env.PGPORT ?? 5432),
    database: process.env.PGDATABASE ?? "agentkit",
    user: role,
    password: process.env[`PG_${suffix}_PASSWORD`] ?? "agentkit",
    max: Number(process.env.PG_POOL_MAX ?? 20),
  });
}

export const ROLE = ROLES;
