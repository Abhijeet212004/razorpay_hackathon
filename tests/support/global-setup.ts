import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { GlobalSetupContext } from "vitest/node";

/**
 * One PostgreSQL container for the whole run. Each suite creates its own database inside
 * it, so isolation is unchanged while the container starts once instead of once per
 * file. Booting one per file also raced the Testcontainers reaper often enough to fail
 * runs for reasons unrelated to the code.
 */
export const POSTGRES_IMAGE = "postgres:16.6-alpine";

let container: StartedPostgreSqlContainer | undefined;

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase("agentkit")
    .withUsername("bootstrap")
    .withPassword("bootstrap")
    // 50 concurrent authorisations, each holding a connection while it waits for the
    // mandate row lock, plus the fixture and assertion pools.
    .withCommand(["postgres", "-c", "max_connections=200"])
    .start();

  provide("postgres", {
    host: container.getHost(),
    port: container.getPort(),
    adminDatabase: container.getDatabase(),
    adminUser: container.getUsername(),
    adminPassword: container.getPassword(),
  });
}

export async function teardown(): Promise<void> {
  await container?.stop();
}

declare module "vitest" {
  export interface ProvidedContext {
    postgres: {
      host: string;
      port: number;
      adminDatabase: string;
      adminUser: string;
      adminPassword: string;
    };
  }
}
