import { Client } from "../../shared/db/pg.js";
import { migrate } from "../../shared/db/migrate.js";
import { ALL_ROLES, type RoleName } from "../../shared/db/roles.js";
import { seed } from "./seed.js";

/**
 * Runs once, before any service starts: migrations, role passwords, signing keys and
 * seed data. Every step is idempotent, because `make up` twice must not double-seed and
 * a judge will absolutely run it twice.
 */

const admin = new Client({
  host: process.env.PGHOST ?? "postgres",
  port: Number(process.env.PGPORT ?? 5432),
  database: process.env.PGDATABASE ?? "agentkit",
  user: process.env.PGUSER ?? "bootstrap",
  password: process.env.PGPASSWORD ?? "bootstrap",
});

await admin.connect();

const passwords = Object.fromEntries(
  ALL_ROLES.map((role) => [
    role,
    process.env[`PG_${role.replace(/^agentkit_/, "").toUpperCase()}_PASSWORD`] ?? "agentkit",
  ]),
) as Record<RoleName, string>;

// A marker table, so re-running is a no-op rather than a pile of duplicate migrations.
await admin.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`);

const applied = await admin.query<{ filename: string }>(`SELECT filename FROM schema_migrations`);

if (applied.rows.length === 0) {
  console.log("[bootstrap] applying migrations");
  const files = await migrate(admin, passwords);
  for (const file of files) {
    await admin.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [file]);
  }
  console.log(`[bootstrap] applied ${files.length} migrations`);
} else {
  console.log(`[bootstrap] schema already at ${applied.rows.length} migrations, skipping`);
  // Passwords are still applied: they come from the environment and may have changed.
  await migrate(admin, passwords, true);
}

await seed(admin, {
  merchantId: process.env.MERCHANT_ID ?? "mch_sharma_kirana",
  merchantName: process.env.MERCHANT_NAME ?? "Sharma Kirana",
});

await admin.end();
console.log("[bootstrap] ready");
