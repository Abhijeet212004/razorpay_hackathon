import pg from "pg";
import type { PoolClient, QueryResult } from "pg";

/**
 * node-postgres is CommonJS, so `import { Pool } from "pg"` fails under real Node ESM
 * even though a bundler resolves it. The interop happens once, here, rather than in
 * every file that needs a connection.
 *
 * Both the value and the type are re-exported, because callers need to construct a pool
 * and to annotate one.
 */
export const { Client, Pool } = pg;

export type Pool = InstanceType<typeof pg.Pool>;
export type Client = InstanceType<typeof pg.Client>;
export type { PoolClient, QueryResult };
