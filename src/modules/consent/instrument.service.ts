import type { Pool, PoolClient } from "pg";
import { setMerchantContext } from "../../shared/db/merchant-context.js";
import { append } from "../ledger/ledger.service.js";
import { withAuthorizationTransaction } from "../../shared/db/transaction.js";
import * as executorRepo from "../executor/executor.repository.js";
import type { InstrumentClient } from "./instrument.client.js";

/**
 * Attaching a payment instrument to a mandate that already exists.
 *
 * The order matters: consent grants the mandate first, and only then is an instrument
 * offered. A mandate with no instrument is still a real grant — it authorises, it just
 * cannot pay — so a shopper who abandons this step has given nothing away, and an agent
 * that tries to buy is told plainly that there is no way to pay rather than failing
 * somewhere deep in the rail.
 */

/** A short read under the merchant's row-level security context. */
async function read<T>(
  pool: Pool,
  merchantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setMerchantContext(client, merchantId);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface InstrumentDeps {
  readonly pool: Pool;
  readonly merchantId: string;
  readonly client: InstrumentClient;
  /** What the bank is asked to allow. Deliberately above our own per-order limit. */
  readonly ceilingMultiple?: bigint;
}

export interface MandateForInstrument {
  readonly mandateId: string;
  readonly agentName: string;
  readonly perTransactionPaise: bigint;
  readonly cumulativePaise: bigint;
  readonly notAfter: Date;
  readonly customerId: string | null;
  readonly tokenId: string | null;
  readonly contact: string;
}

export async function readMandateForInstrument(
  deps: InstrumentDeps,
  mandateId: string,
): Promise<MandateForInstrument | null> {
  return read(deps.pool, deps.merchantId, async (client) => {
    const result = await client.query<{
      mandate_id: string;
      agent_name: string;
      per_transaction_paise: string;
      cumulative_paise: string;
      not_after: Date;
      payment_customer_ref: string | null;
      payment_token_ref: string | null;
      contact: string | null;
    }>(
      `SELECT m.mandate_id, a.name AS agent_name,
              m.per_transaction_paise::text, m.cumulative_paise::text, m.not_after,
              m.payment_customer_ref, m.payment_token_ref,
              c.contact
         FROM mandates m
         JOIN agents a ON a.agent_id = m.agent_id
         LEFT JOIN consent_requests c ON c.mandate_id = m.mandate_id
        WHERE m.mandate_id = $1 AND m.state = 'live'`,
      [mandateId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      mandateId: row.mandate_id,
      agentName: row.agent_name,
      perTransactionPaise: BigInt(row.per_transaction_paise),
      cumulativePaise: BigInt(row.cumulative_paise),
      notAfter: row.not_after,
      customerId: row.payment_customer_ref,
      tokenId: row.payment_token_ref,
      contact: row.contact ?? "",
    };
  });
}

/** The ceiling the bank is asked for: the monthly cap, not the per-order limit. */
export function bankCeiling(mandate: MandateForInstrument): bigint {
  return mandate.cumulativePaise;
}

export interface BeginResult {
  readonly customerId: string;
  readonly railOrderId: string;
  readonly amountPaise: string;
}

export async function beginInstrumentSetup(
  deps: InstrumentDeps,
  mandateId: string,
  method: "upi" | "card" = "upi",
): Promise<BeginResult | null> {
  const mandate = await readMandateForInstrument(deps, mandateId);
  if (mandate === null) return null;

  const setup = await deps.client.begin({
    // The rail needs a name and an email; neither is stored here, and the contact it is
    // given is the one the shopper already proved they control by entering the code.
    name: "Shopper",
    email: `${mandateId}@mandate.invalid`,
    contact: mandate.contact,
    maxAmountPaise: bankCeiling(mandate).toString(),
    // The smallest debit the rail accepts. Registering a mandate is not a purchase.
    amountPaise: "100",
    expiresAt: mandate.notAfter.toISOString(),
    method,
    notes: { mandate_id: mandateId },
  });

  // Stored before the shopper is sent to their bank, so completing the setup never has to
  // trust a customer id handed back by a browser.
  await read(deps.pool, deps.merchantId, async (client) => {
    await client.query(
      `UPDATE mandates SET payment_customer_ref = $2 WHERE mandate_id = $1`,
      [mandateId, setup.customerId],
    );
  });

  return {
    customerId: setup.customerId,
    railOrderId: setup.railOrderId,
    amountPaise: setup.amountPaise,
  };
}

export type CompleteOutcome =
  | { kind: "ATTACHED"; method: string }
  | { kind: "NOT_YET" }
  | { kind: "UNKNOWN_MANDATE" };

export async function completeInstrumentSetup(
  deps: InstrumentDeps,
  mandateId: string,
): Promise<CompleteOutcome> {
  const mandate = await readMandateForInstrument(deps, mandateId);
  if (mandate === null || mandate.customerId === null) return { kind: "UNKNOWN_MANDATE" };

  // Read from the rail, never from the browser. A page cannot assert that a bank approved
  // anything; only the rail can say so.
  const token = await deps.client.token(mandate.customerId);
  if (token === null) return { kind: "NOT_YET" };

  await withAuthorizationTransaction(
    deps.pool,
    {
      merchantId: deps.merchantId,
      lockTimeoutMs: 3_000,
      statementTimeoutMs: 5_000,
      retryAttempts: 3,
      retryBackoffMs: [10, 40, 160],
    },
    async (client) => {
      await executorRepo.attachPaymentInstrument(client, mandateId, {
        customerId: mandate.customerId!,
        tokenId: token.tokenId,
        maxAmountPaise: token.maxAmountPaise === null ? null : BigInt(token.maxAmountPaise),
      });
      await append(client, {
        chainId: mandateId,
        kind: "MANDATE_ISSUED",
        merchantId: deps.merchantId,
        ref: mandateId,
        payloadRedacted: {
          event: "instrument_attached",
          method: token.method,
          // Ids only. There is nothing here that identifies an instrument to a reader.
          customer_ref: mandate.customerId,
          bank_ceiling_paise: token.maxAmountPaise ?? null,
        },
      });
    },
  );

  return { kind: "ATTACHED", method: token.method };
}

/** An order that exists at the rail and is still waiting for someone to pay it. */
export async function readPayableOrder(
  pool: Pool,
  merchantId: string,
  intentId: string,
): Promise<{
  intentId: string;
  state: string;
  amountPaise: bigint;
  railOrderId: string | null;
} | null> {
  return read(pool, merchantId, async (client) => {
    const result = await client.query<{
      intent_id: string;
      state: string;
      amount_paise: string;
      rzp_order_id: string | null;
    }>(
      `SELECT intent_id, state, amount_paise::text, rzp_order_id
         FROM orders WHERE intent_id = $1`,
      [intentId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      intentId: row.intent_id,
      state: row.state,
      amountPaise: BigInt(row.amount_paise),
      railOrderId: row.rzp_order_id,
    };
  });
}
