import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/**
 * User usage tracking is additive and must also work on existing deployments
 * that do not run drizzle-kit during startup.
 */
export async function ensureUserUsageTables(): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "user_session_log"
    ADD COLUMN IF NOT EXISTS "last_heartbeat_at" timestamp with time zone,
    ADD COLUMN IF NOT EXISTS "last_client_state" text,
    ADD COLUMN IF NOT EXISTS "last_page_path" text,
    ADD COLUMN IF NOT EXISTS "busy_seconds" integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "idle_seconds" integer NOT NULL DEFAULT 0
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "user_usage_event" (
      "id" text PRIMARY KEY DEFAULT gen_random_uuid(),
      "user_id" text NOT NULL,
      "session_id" text,
      "event_type" text NOT NULL,
      "occurred_at" timestamp with time zone NOT NULL DEFAULT now(),
      "page_path" text,
      "page_label" text,
      "report_name" text,
      "file_type" text,
      CONSTRAINT "user_usage_event_type_check"
        CHECK ("event_type" IN ('page_visit', 'report_generated', 'visibility'))
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "user_usage_event_user_occurred_at_idx"
    ON "user_usage_event" ("user_id", "occurred_at")
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "user_usage_event_session_occurred_at_idx"
    ON "user_usage_event" ("session_id", "occurred_at")
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "user_session_activity_segment" (
      "id" text PRIMARY KEY DEFAULT gen_random_uuid(),
      "session_id" text NOT NULL,
      "user_id" text NOT NULL,
      "state" text NOT NULL,
      "started_at" timestamp with time zone NOT NULL,
      "ended_at" timestamp with time zone NOT NULL,
      "duration_seconds" integer NOT NULL,
      "page_path" text,
      CONSTRAINT "user_session_activity_segment_state_check"
        CHECK ("state" IN ('busy', 'idle'))
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "user_session_segment_session_started_at_idx"
    ON "user_session_activity_segment" ("session_id", "started_at")
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "user_session_segment_user_started_at_idx"
    ON "user_session_activity_segment" ("user_id", "started_at")
  `);
}