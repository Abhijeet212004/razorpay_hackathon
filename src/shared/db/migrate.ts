import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { ALL_ROLES, type RoleName } from "./roles.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations", import.meta.url));

/** Role passwords cannot be bound as parameters, so they are quoted. */
function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export async function migrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((f) => f.endsWith(".sql")).sort();
}

/**
 * Apply every migration in order as a superuser, then set role passwords from the
 * supplied map. Passwords never appear in a migration file.
 *
 * All migrations run in one transaction: a database with roles but no grants is one
 * where row level security silently does nothing.
 */
export async function migrate(
  client: Client,
  passwords: Partial<Record<RoleName, string>> = {},
  skipSchema = false,
): Promise<string[]> {
  const files = await migrationFiles();

  if (!skipSchema) {
    await client.query("BEGIN");
    try {
      for (const file of files) {
        const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
        await client.query(sql);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  for (const role of ALL_ROLES) {
    const password = passwords[role];
    if (password === undefined) continue;
    await client.query(
      `ALTER ROLE ${quoteIdent(role)} WITH PASSWORD ${quoteLiteral(password)}`,
    );
  }

  return files;
}
