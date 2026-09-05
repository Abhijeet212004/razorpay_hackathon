import { randomBytes, createHash } from "node:crypto";
import type { Pool } from "pg";
import { setMerchantContext } from "../../shared/db/merchant-context.js";
import type { Handler, HandlerResult, RequestContext, Route } from "../../shared/http.js";
import * as console_ from "../console/console.repository.js";
import * as merchants from "../merchant/merchant.repository.js";
import { MerchantConfigSchema } from "../merchant/merchant.validation.js";
import {
  closeSession,
  cookieValue,
  createUser,
  emailTaken,
  openSession,
  readSession,
  sessionCookie,
  clearedCookie,
  signIn,
  type DashboardUser,
} from "./dashboard.auth.js";
import { chainPage } from "./dashboard.chain.js";
import { decisionPage } from "./dashboard.detail.js";
import { docsPage } from "./dashboard.docs.js";
import * as pages from "./dashboard.pages.js";

/**
 * The dashboard. Server-rendered, session-authenticated, and scoped to one merchant by
 * the session rather than by anything in the request.
 *
 * Every page here is rendered only after a session resolves to a merchant, and every
 * query is made under that merchant's row level security context. A page a merchant may
 * not see is a page that is never rendered — there is no client-side filtering to defeat.
 */

const HTML = { "Content-Type": "text/html; charset=utf-8" };

export interface DashboardDeps {
  readonly pool: Pool;
  readonly apiBase: string;
  readonly secureCookies: boolean;
}

function form(raw: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(raw).entries());
}

function redirect(to: string, cookie?: string): HandlerResult {
  return {
    status: 303,
    headers: { Location: to, ...(cookie === undefined ? {} : { "Set-Cookie": cookie }) },
    body: "",
  };
}

function session(ctx: RequestContext): string | undefined {
  const raw = ctx.headers.cookie;
  return cookieValue(Array.isArray(raw) ? raw[0] : raw, "agentkit_dash");
}

/** Wraps a page so it cannot render without a session that resolves to a merchant. */
function signedIn(
  deps: DashboardDeps,
  render: (ctx: RequestContext, user: DashboardUser) => Promise<HandlerResult> | HandlerResult,
): Handler {
  return async (ctx) => {
    const user = await readSession(deps.pool, session(ctx));
    if (user === null) return redirect("/dashboard/signin");
    return render(ctx, user);
  };
}

/** Every read runs under the merchant's own tenant context, never a global one. */
async function scoped<T>(
  pool: Pool,
  merchantId: string,
  fn: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setMerchantContext(client, merchantId);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function dashboardRoutes(deps: DashboardDeps): Route[] {
  const shellFor = async (user: DashboardUser, title: string, active: string) => {
    const record = await scoped(deps.pool, user.merchantId, (c) =>
      merchants.read(c, user.merchantId),
    );
    return {
      opts: {
        title,
        active,
        merchantName: record?.displayName ?? user.merchantId,
        email: user.email,
      },
      record,
    };
  };

  return [
    /* ---------------------------------------------------------- sign up */
    {
      method: "GET",
      path: "/dashboard/signup",
      handler: () => ({ status: 200, headers: HTML, body: pages.signUpPage() }),
    },
    {
      method: "POST",
      path: "/dashboard/signup",
      handler: async (ctx) => {
        const f = form(ctx.rawBody);
        const values = { business: f.business ?? "", email: f.email ?? "", site: f.site ?? "", catalog: f.catalog ?? "" };
        const fail = (message: string) => ({
          status: 400, headers: HTML, body: pages.signUpPage(message, values),
        });

        if (!f.email || !f.password || !f.business || !f.site || !f.catalog) {
          return fail("Every field is needed to set your shop up.");
        }
        if (f.password.length < 10) return fail("Use a password of at least 10 characters.");
        if (await emailTaken(deps.pool, f.email)) {
          return fail("There is already an account for that address. Sign in instead.");
        }

        const created = await merchants.onboard(deps.pool, {
          display_name: f.business,
          catalog_url: f.catalog,
          public_base_url: f.site,
        });
        const user = await createUser(deps.pool, {
          email: f.email, password: f.password, merchantId: created.merchantId, displayName: f.business,
        });
        const sid = await openSession(deps.pool, user);

        // The credentials exist only in this response. Nothing stores them.
        return {
          status: 200,
          headers: { ...HTML, "Set-Cookie": sessionCookie(sid, deps.secureCookies) },
          body: pages.keysPage(
            { title: "API keys", active: "keys", merchantName: f.business, email: user.email },
            { apiKeyPrefix: created.apiKey.slice(0, 11), freshApiKey: created.apiKey, freshFulfilToken: created.fulfilToken },
          ),
        };
      },
    },

    /* ---------------------------------------------------------- sign in */
    {
      method: "GET",
      path: "/dashboard/signin",
      handler: () => ({ status: 200, headers: HTML, body: pages.signInPage() }),
    },
    {
      method: "POST",
      path: "/dashboard/signin",
      handler: async (ctx) => {
        const f = form(ctx.rawBody);
        const user = await signIn(deps.pool, f.email ?? "", f.password ?? "");
        if (user === null) {
          // One message for both halves: which one was wrong is not the caller's business.
          return { status: 401, headers: HTML, body: pages.signInPage("That email and password do not match.") };
        }
        return redirect("/dashboard", sessionCookie(await openSession(deps.pool, user), deps.secureCookies));
      },
    },
    {
      method: "POST",
      path: "/dashboard/signout",
      handler: async (ctx) => {
        await closeSession(deps.pool, session(ctx));
        return redirect("/dashboard/signin", clearedCookie());
      },
    },

    /* --------------------------------------------------------- overview */
    {
      method: "GET",
      path: "/dashboard",
      handler: signedIn(deps, async (_ctx, user) => {
        const { opts, record } = await shellFor(user, "Overview", "home");
        if (record === null) return redirect("/dashboard/signin");

        const [decisions, mandateRows, denials, quarantined] = await Promise.all([
          console_.recentDecisions(deps.pool, user.merchantId, 40),
          console_.mandates(deps.pool, user.merchantId),
          console_.denialCounts(deps.pool, user.merchantId),
          console_.quarantined(deps.pool, user.merchantId),
        ]);

        return {
          status: 200, headers: HTML,
          body: pages.overviewPage(opts, {
            merchant: record,
            decisions,
            mandates: mandateRows,
            denials,
            quarantined: Array.isArray(quarantined) ? quarantined.length : Number(quarantined ?? 0),
          }),
        };
      }),
    },

    /* --------------------------------------------------------- activity */
    {
      method: "GET",
      path: "/dashboard/activity",
      handler: signedIn(deps, async (_ctx, user) => {
        const { opts } = await shellFor(user, "Agent activity", "activity");
        const decisions = await console_.recentDecisions(deps.pool, user.merchantId, 200);
        return { status: 200, headers: HTML, body: pages.activityPage(opts, decisions) };
      }),
    },

    /* ------------------------------------------------- one decision */
    {
      method: "GET",
      path: "/dashboard/activity/:intentId",
      handler: signedIn(deps, async (ctx, user) => {
        const { opts } = await shellFor(user, "Decision", "activity");
        const entries = await console_.trace(deps.pool, user.merchantId, ctx.params.intentId ?? "");
        return {
          status: 200, headers: HTML,
          body: decisionPage(opts, ctx.params.intentId ?? "", entries),
        };
      }),
    },

    {
      /** The same decision, one level down: the hashes, recomputed rather than displayed. */
      method: "GET",
      path: "/dashboard/activity/:intentId/chain",
      handler: signedIn(deps, async (ctx, user) => {
        const { opts } = await shellFor(user, "Chain", "activity");
        const intentId = ctx.params.intentId ?? "";
        const { chainId, entries } = await console_.chainForIntent(
          deps.pool, user.merchantId, intentId,
        );
        return {
          status: 200, headers: HTML,
          body: chainPage(opts, intentId, chainId, entries),
        };
      }),
    },

    /* --------------------------------------------------------- mandates */
    {
      method: "GET",
      path: "/dashboard/mandates",
      handler: signedIn(deps, async (_ctx, user) => {
        const { opts } = await shellFor(user, "Permissions", "mandates");
        const rows = await console_.mandates(deps.pool, user.merchantId);
        return { status: 200, headers: HTML, body: pages.mandatesPage(opts, rows) };
      }),
    },

    /* ------------------------------------------------------------- keys */
    {
      method: "GET",
      path: "/dashboard/keys",
      handler: signedIn(deps, async (_ctx, user) => {
        const { opts } = await shellFor(user, "API keys", "keys");
        // Scoped: merchants is under forced row level security, so an unscoped read here
        // returns nothing and the page claims no key exists while agents are using one.
        const row = await scoped(deps.pool, user.merchantId, (c) =>
          c.query<{ api_key_prefix: string | null }>(
            `SELECT api_key_prefix FROM merchants WHERE merchant_id = $1`, [user.merchantId],
          ),
        );
        return {
          status: 200, headers: HTML,
          body: pages.keysPage(opts, { apiKeyPrefix: row.rows[0]?.api_key_prefix ?? null }),
        };
      }),
    },
    {
      method: "POST",
      path: "/dashboard/keys/rotate",
      handler: signedIn(deps, async (_ctx, user) => {
        const { opts } = await shellFor(user, "API keys", "keys");
        const apiKey = `ak_${randomBytes(24).toString("base64url")}`;
        const fulfilToken = `aft_${randomBytes(24).toString("base64url")}`;
        const sha = (s: string) => createHash("sha256").update(s, "utf8").digest();

        // The old pair stops working the moment this commits.
        await scoped(deps.pool, user.merchantId, (c) =>
          c.query(
            `UPDATE merchants SET api_key_hash = $2, api_key_prefix = $3, fulfil_token_hash = $4
              WHERE merchant_id = $1`,
            [user.merchantId, sha(apiKey), apiKey.slice(0, 11), sha(fulfilToken)],
          ),
        );

        return {
          status: 200, headers: HTML,
          body: pages.keysPage(opts, {
            apiKeyPrefix: apiKey.slice(0, 11), freshApiKey: apiKey, freshFulfilToken: fulfilToken,
          }),
        };
      }),
    },

    /* ------------------------------------------------------ integration */
    {
      method: "GET",
      path: "/dashboard/integration",
      handler: signedIn(deps, async (ctx, user) => {
        const { opts, record } = await shellFor(user, "Integration", "integration");
        if (record === null) return redirect("/dashboard/signin");
        return {
          status: 200, headers: HTML,
          body: pages.integrationPage(opts, record, ctx.query.get("saved") === "1"),
        };
      }),
    },
    {
      method: "POST",
      path: "/dashboard/integration",
      handler: signedIn(deps, async (ctx, user) => {
        const f = form(ctx.rawBody);
        const parsed = MerchantConfigSchema.safeParse({
          catalog_url: f.catalog || undefined,
          fulfil_url: f.fulfil || undefined,
          authorize_url: f.authorize || undefined,
          public_base_url: f.site || undefined,
        });
        if (!parsed.success) {
          const { opts, record } = await shellFor(user, "Integration", "integration");
          if (record === null) return redirect("/dashboard/signin");
          return { status: 400, headers: HTML, body: pages.integrationPage(opts, record, false) };
        }
        await scoped(deps.pool, user.merchantId, (c) =>
          merchants.updateConfig(c, user.merchantId, parsed.data),
        );
        return redirect("/dashboard/integration?saved=1");
      }),
    },

    /* ------------------------------------------------------------- docs */

    /**
     * The documentation, readable without an account.
     *
     * A merchant deciding whether to integrate has to be able to read how before they
     * sign up. The signed-in route below renders the same pages with their own merchant
     * id and endpoints filled in; this one shows the placeholders.
     */
    {
      method: "GET",
      path: "/docs",
      handler: async (ctx): Promise<HandlerResult> => ({
        status: 200,
        headers: HTML,
        body: docsPage(
          { title: "Documentation", active: "docs", merchantName: "AgentKit", email: "" },
          {
            merchantId: "mch_your_shop",
            apiBase: deps.apiBase,
            catalogUrl: null,
            siteUrl: null,
            basePath: "/docs",
          },
          ctx.query.get("p") ?? "overview",
        ),
      }),
    },
    {
      method: "GET",
      path: "/dashboard/docs",
      handler: signedIn(deps, async (ctx, user) => {
        const { opts, record } = await shellFor(user, "Documentation", "docs");
        return {
          status: 200, headers: HTML,
          body: docsPage(opts, {
            merchantId: user.merchantId,
            apiBase: deps.apiBase,
            catalogUrl: record?.catalogUrl ?? null,
            siteUrl: record?.publicBaseUrl ?? null,
            basePath: "/dashboard/docs",
          }, ctx.query.get("p") ?? "overview"),
        };
      }),
    },
  ];
}
