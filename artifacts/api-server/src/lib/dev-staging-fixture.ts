import bcrypt from "bcryptjs";
import { db, appUsersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

/**
 * Local-only fixture configuration for the staged-upload lifecycle check.
 * It requires both a development runtime and an explicit development
 * environment opt-in. The password remains in the runtime secret store.
 */
export const DEV_STAGING_ADMIN_EMAIL = "dev-staging-fixture-admin@local.invalid";
export const DEV_STAGING_FIXTURE_PROJECT = "__DEV_E2E_STAGE__";
// Parsed from dev-staging-lifecycle.csv. This full-row identity is deliberately
// required for cleanup in addition to the visible project marker.
export const DEV_STAGING_FIXTURE_ROW_HASH =
  "5078666efc3bc5d217d077d031c09d3bdd5bfb1c4a0e0eeba71b4f1f50c91541";

export function isDevelopmentStagingFixtureRuntime(): boolean {
  return (
    process.env.NODE_ENV === "development" &&
    process.env.DEV_STAGING_FIXTURE_ENABLED === "true" &&
    typeof process.env.AUTH_PASSWORD === "string" &&
    process.env.AUTH_PASSWORD.length > 0
  );
}

export function isDevelopmentStagingFixturePoolRow(
  job: string,
  hash: string,
): boolean {
  return job === DEV_STAGING_FIXTURE_PROJECT && hash === DEV_STAGING_FIXTURE_ROW_HASH;
}

export async function seedDevelopmentStagingAdmin(): Promise<void> {
  if (!isDevelopmentStagingFixtureRuntime()) return;

  // Retire the one legacy, hard-coded development identity created before this
  // fixture became secret-backed. Its reserved .local.invalid address can never
  // be a normal account, and this runs only under the explicit local opt-in.
  await db
    .delete(appUsersTable)
    .where(eq(appUsersTable.email, "dev-staging-admin@local.invalid"));

  const passwordHash = await bcrypt.hash(process.env.AUTH_PASSWORD!, 10);
  await db
    .insert(appUsersTable)
    .values({
      email: DEV_STAGING_ADMIN_EMAIL,
      displayName: "Development staging test admin",
      passwordHash,
      role: "admin",
      mustChangePassword: false,
    })
    .onConflictDoNothing();
  logger.info({ email: DEV_STAGING_ADMIN_EMAIL }, "Development staging admin ensured");
}