import type { Pool } from "pg";
import { setMerchantContext } from "../../shared/db/merchant-context.js";
import { verifyChain } from "../ledger/ledger.service.js";
import { listChainIds } from "../ledger/ledger.repository.js";

/**
 * The operator view: every merchant, in aggregate, and nothing else.
 *
 * A cross-merchant read is exactly what row level security forbids, and granting
 * BYPASSRLS to make this page work would void that protection while every existing test
 * stayed green. So the aggregation runs per merchant, inside the merchant's own context,
 * and writes counts into operator_metrics. The console reads only that table, which holds
 * no identifiers — a property a test enforces rather than a convention.
 */

export interface OperatorRow {
  merchantId: string;
  decisionsTotal: number;
  denialsTotal: number;
  gmvPaise: string;
  activeMandates: number;
  reservationsHeld: string;
  chainStatus: "ok" | "broken";
  refreshedAt: Date;
}

/** Runs in the worker. One transaction per merchant, each in that merchant's context. */
export async function refreshOperatorMetrics(
  pool: Pool,
  merchantIds: readonly string[],
): Promise<number> {
  const windowStart = new Date();
  windowStart.setMinutes(0, 0, 0);

  let written = 0;

  for (const merchantId of merchantIds) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await setMerchantContext(client, merchantId);

      const stats = await client.query<{
        decisions: string; denials: string; gmv: string; mandates: string; held: string;
      }>(
        `SELECT
           (SELECT COUNT(*) FROM ledger WHERE kind = 'DECISION')::text AS decisions,
           (SELECT COUNT(*) FROM ledger WHERE kind = 'DECISION'
              AND payload_redacted -> 'payload' ->> 'verdict' = 'DENY')::text AS denials,
           (SELECT COALESCE(SUM(amount_paise),0) FROM reservations
              WHERE state = 'captured')::text AS gmv,
           (SELECT COUNT(*) FROM mandates WHERE state = 'live')::text AS mandates,
           (SELECT COALESCE(SUM(amount_paise),0) FROM reservations
              WHERE state = 'held')::text AS held`,
      );

      const byCode = await client.query<{ reason_code: string; count: string }>(
        `SELECT payload_redacted -> 'payload' ->> 'reason_code' AS reason_code,
                COUNT(*)::text AS count
           FROM ledger WHERE kind = 'DECISION'
            AND payload_redacted -> 'payload' ->> 'verdict' = 'DENY'
          GROUP BY 1`,
      );

      let chainStatus: "ok" | "broken" = "ok";
      for (const chainId of await listChainIds(client)) {
        if (!(await verifyChain(client, chainId)).valid) {
          chainStatus = "broken";
          break;
        }
      }

      const row = stats.rows[0]!;
      await client.query(
        `INSERT INTO operator_metrics (merchant_id, window_start, decisions_total,
           denials_total, denials_by_code, gmv_paise, active_mandates, reservations_held,
           chain_status, breaker_trips, refreshed_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,0,now())
         ON CONFLICT (merchant_id, window_start) DO UPDATE SET
           decisions_total = EXCLUDED.decisions_total,
           denials_total = EXCLUDED.denials_total,
           denials_by_code = EXCLUDED.denials_by_code,
           gmv_paise = EXCLUDED.gmv_paise,
           active_mandates = EXCLUDED.active_mandates,
           reservations_held = EXCLUDED.reservations_held,
           chain_status = EXCLUDED.chain_status,
           refreshed_at = now()`,
        [
          merchantId,
          windowStart.toISOString(),
          Number(row.decisions),
          Number(row.denials),
          // Counts keyed by reason code. No subject, no intent, no mandate.
          JSON.stringify(Object.fromEntries(byCode.rows.map((r) => [r.reason_code, Number(r.count)]))),
          row.gmv,
          Number(row.mandates),
          row.held,
          chainStatus,
        ],
      );

      await client.query("COMMIT");
      written += 1;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return written;
}

export async function readOperatorMetrics(pool: Pool): Promise<OperatorRow[]> {
  const result = await pool.query<{
    merchant_id: string; decisions_total: string; denials_total: string; gmv_paise: string;
    active_mandates: number; reservations_held: string; chain_status: "ok" | "broken";
    refreshed_at: Date;
  }>(
    `SELECT DISTINCT ON (merchant_id)
            merchant_id, decisions_total::text, denials_total::text, gmv_paise::text,
            active_mandates, reservations_held::text, chain_status, refreshed_at
       FROM operator_metrics
      ORDER BY merchant_id, window_start DESC`,
  );
  return result.rows.map((r) => ({
    merchantId: r.merchant_id,
    decisionsTotal: Number(r.decisions_total),
    denialsTotal: Number(r.denials_total),
    gmvPaise: r.gmv_paise,
    activeMandates: r.active_mandates,
    reservationsHeld: r.reservations_held,
    chainStatus: r.chain_status,
    refreshedAt: r.refreshed_at,
  }));
}
