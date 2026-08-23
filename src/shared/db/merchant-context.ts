import type { PoolClient } from "pg";

/**
 * Sets the merchant context that every row level security policy reads.
 *
 * SET LOCAL takes no bind parameters, so this uses set_config with is_local = true,
 * which has identical semantics. More importantly, SET LOCAL outside a transaction is a
 * silent no-op: the setting never lands, every policy sees NULL, and every query returns
 * zero rows. A tenant control that fails by making data invisible looks exactly like a
 * tenant control that works, so this reads the value back in a separate statement and
 * throws if it did not stick.
 *
 * The read-back is a second round trip on purpose. Within one statement set_config
 * returns the value it was handed whether or not a transaction is open.
 */

export class MerchantContextNotSetError extends Error {
  constructor(readonly merchantId: string) {
    super(
      `merchant context for ${merchantId} did not persist, which means no transaction ` +
        "was open. SET LOCAL outside a transaction is a silent no-op and would leave " +
        "every row level security policy matching nothing.",
    );
    this.name = "MerchantContextNotSetError";
  }
}

export const MERCHANT_CONTEXT_SETTING = "agentkit.merchant_id";

export async function setMerchantContext(
  client: PoolClient,
  merchantId: string,
): Promise<void> {
  await client.query(`SELECT set_config($1, $2, true)`, [
    MERCHANT_CONTEXT_SETTING,
    merchantId,
  ]);

  const check = await client.query<{ value: string | null }>(
    `SELECT current_setting($1, true) AS value`,
    [MERCHANT_CONTEXT_SETTING],
  );

  if (check.rows[0]?.value !== merchantId) {
    throw new MerchantContextNotSetError(merchantId);
  }
}
