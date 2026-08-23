/**
 * Database roles.
 *
 * agentkit_owner owns every table but is used by no service: it exists so FORCE row
 * level security has a non-superuser principal to constrain, since a superuser bypasses
 * RLS unconditionally.
 */
export const ROLES = {
  owner: "agentkit_owner",
  kernel: "agentkit_kernel",
  worker: "agentkit_worker",
  console: "agentkit_console",
  admin: "agentkit_admin",
} as const;

export type RoleName = (typeof ROLES)[keyof typeof ROLES];

/** Roles a running service may connect as. */
export const SERVICE_ROLES: readonly RoleName[] = [
  ROLES.kernel,
  ROLES.worker,
  ROLES.console,
] as const;

export const ALL_ROLES: readonly RoleName[] = Object.values(ROLES);

export function passwordEnvVar(role: RoleName): string {
  return `PG_${role.replace(/^agentkit_/, "").toUpperCase()}_PASSWORD`;
}
