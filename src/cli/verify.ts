import { Pool } from "../shared/db/pg.js";
import { ROLES } from "../shared/db/roles.js";
import { setMerchantContext } from "../shared/db/merchant-context.js";
import { listChainIds } from "../modules/ledger/ledger.repository.js";
import { verifyChain, type ChainVerification } from "../modules/ledger/ledger.service.js";

/**
 * Walks every hash chain for a merchant and recomputes each hash from the raw rows.
 *
 * Nothing here trusts a stored hash. Each entry is re-derived from its predecessor's hash
 * and its own canonical payload, so a row edited in place is detected even when its hash
 * column was edited to match. A reviewer can run this without going through our UI, and
 * it connects as the read-only console role so it cannot repair what it finds.
 */

export interface VerifyReport {
  readonly merchantId: string;
  readonly chains: readonly ChainVerification[];
  readonly ok: boolean;
}

export async function verifyMerchant(
  pool: Pool,
  merchantId: string,
  onlyChainId?: string,
): Promise<VerifyReport> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setMerchantContext(client, merchantId);

    const chainIds =
      onlyChainId === undefined ? await listChainIds(client) : [onlyChainId];

    const chains: ChainVerification[] = [];
    for (const chainId of chainIds) {
      chains.push(await verifyChain(client, chainId));
    }

    await client.query("COMMIT");
    return { merchantId, chains, ok: chains.every((c) => c.valid) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function formatReport(report: VerifyReport): string {
  const lines: string[] = [];
  lines.push(`merchant ${report.merchantId}`);

  for (const chain of report.chains) {
    const status = chain.valid ? "ok    " : "BROKEN";
    const where = chain.brokenAt === null ? "" : `  first break at seq ${chain.brokenAt}`;
    lines.push(`  ${status}  ${chain.chainId}  ${chain.entries} entries${where}`);
  }

  const broken = report.chains.filter((c) => !c.valid).length;
  lines.push(
    broken === 0
      ? `  ${report.chains.length} chains verified, every hash recomputed from raw rows`
      : `  ${broken} of ${report.chains.length} chains FAILED verification`,
  );
  return lines.join("\n");
}

function parseArgs(argv: readonly string[]): { merchant?: string; mandate?: string } {
  const args: { merchant?: string; mandate?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    if (value === undefined) continue;
    if (argv[i] === "--merchant") args.merchant = value;
    if (argv[i] === "--mandate") args.mandate = value;
  }
  return args;
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const merchantId = args.merchant ?? process.env.MERCHANT_ID;

  if (merchantId === undefined) {
    process.stderr.write("usage: agentkit verify --merchant <id> [--mandate <id>]\n");
    return 2;
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    user: process.env.PG_CONSOLE_USER ?? ROLES.console,
    password: process.env.PG_CONSOLE_PASSWORD,
  });

  try {
    const report = await verifyMerchant(pool, merchantId, args.mandate);
    process.stdout.write(`${formatReport(report)}\n`);
    return report.ok ? 0 : 1;
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("verify.js") || process.argv[1]?.endsWith("verify.ts")) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`verify failed: ${String(error)}\n`);
      process.exit(3);
    },
  );
}
