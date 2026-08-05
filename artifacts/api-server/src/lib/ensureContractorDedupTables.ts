import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

/**
 * Idempotent boot-time guard: creates the contractor_aliases and
 * contractor_dedup_proposals tables if they don't already exist.
 *
 * The project uses drizzle-kit push for schema changes (no versioned
 * migration files). Running push against a new production database before
 * the first deploy is the canonical path, but this guard ensures the routes
 * never throw "relation does not exist" if push was not run (e.g. first
 * deployment after the feature is merged). Safe to call every boot — the
 * IF NOT EXISTS clause makes it a no-op on already-provisioned databases.
 */
export async function ensureContractorDedupTables(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS contractor_aliases (
      alias_key   TEXT PRIMARY KEY,
      canonical_key TEXT NOT NULL,
      raw_name    TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS contractor_dedup_proposals (
      id            SERIAL PRIMARY KEY,
      canonical_key TEXT NOT NULL,
      canonical_display TEXT NOT NULL,
      alias_entries JSONB NOT NULL DEFAULT '[]',
      confidence    DOUBLE PRECISION,
      reason        TEXT,
      status        TEXT NOT NULL DEFAULT 'pending',
      reviewed_at   TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  logger.info("Contractor dedup tables ensured");
}
