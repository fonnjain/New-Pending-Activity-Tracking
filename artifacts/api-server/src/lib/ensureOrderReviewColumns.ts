import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

// Additive, idempotent column upgrades for Order Review tables. Runs at startup
// so production picks up nullable additive fields without a manual migration.
export async function ensureOrderReviewColumns(): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "order_review_rows"
    ADD COLUMN IF NOT EXISTS "bal_wo_mt" double precision
  `);
  await db.execute(sql`
    ALTER TABLE "order_review_imports"
    ADD COLUMN IF NOT EXISTS "override_reason" text,
    ADD COLUMN IF NOT EXISTS "override_at" timestamp with time zone,
    ADD COLUMN IF NOT EXISTS "override_by" text,
    ADD COLUMN IF NOT EXISTS "override_details" jsonb
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "order_review_anomalies" (
      "id" serial PRIMARY KEY,
      "project" text NOT NULL UNIQUE,
      "status" text NOT NULL DEFAULT 'open',
      "explanation" text NOT NULL DEFAULT '',
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_by" text,
      CONSTRAINT "order_review_anomalies_status_check"
        CHECK ("status" IN ('open', 'explained', 'superseded'))
    )
  `);
  await db.execute(sql`
    ALTER TABLE "order_review_anomalies"
    ADD COLUMN IF NOT EXISTS "signature" text NOT NULL DEFAULT 'C',
    ADD COLUMN IF NOT EXISTS "reason" text NOT NULL DEFAULT ''
  `);
  await db.execute(sql`
    ALTER TABLE "order_review_anomalies"
    DROP CONSTRAINT IF EXISTS "order_review_anomalies_status_check"
  `);
  await db.execute(sql`
    ALTER TABLE "order_review_anomalies"
    ADD CONSTRAINT "order_review_anomalies_status_check"
    CHECK ("status" IN ('open', 'explained', 'superseded'))
  `);
  await db.execute(sql`
    INSERT INTO "order_review_anomalies" ("project", "status", "explanation")
    VALUES
      ('903', 'superseded', 'Superseded by the corrected Order Review snapshot.'),
      ('775', 'explained', 'Project was cancelled.'),
      ('840', 'open', 'Awaiting investigation.'),
      ('896', 'open', 'Awaiting investigation.'),
      ('VS-189', 'open', 'Awaiting investigation.')
    ON CONFLICT ("project") DO NOTHING
  `);
  await db.execute(sql`
    UPDATE "order_review_anomalies"
    SET
      "signature" = CASE "project"
        WHEN '903' THEN 'B'
        WHEN '775' THEN 'A'
        WHEN '840' THEN 'D'
        WHEN '896' THEN 'A'
        WHEN 'VS-189' THEN 'A'
        ELSE "signature"
      END,
      "reason" = CASE "project"
        WHEN '903' THEN 'correction'
        WHEN '775' THEN 'short close'
        WHEN '840' THEN 'scope reduction'
        WHEN '896' THEN 'short close'
        WHEN 'VS-189' THEN 'short close'
        ELSE "reason"
      END,
      "explanation" = CASE "project"
        WHEN '840' THEN
          'Scope reduction: WO Order Qty fell from 370.608 to 357.143 MT and all stages followed; 1DD2A and 1DD9M increased through reallocation.'
        WHEN '896' THEN
          'Same short-close signature as project 775; pending VTPL confirmation.'
        WHEN 'VS-189' THEN
          'Same short-close signature as project 775; pending VTPL confirmation.'
        ELSE "explanation"
      END,
      "updated_at" = now(),
      "updated_by" = 'system'
    WHERE "project" IN ('903', '775', '840', '896', 'VS-189')
      AND (
        ("project" = '903' AND ("signature" <> 'B' OR "reason" <> 'correction'))
        OR ("project" = '775' AND ("signature" <> 'A' OR "reason" <> 'short close'))
        OR ("project" = '840' AND ("signature" <> 'D' OR "reason" <> 'scope reduction'))
        OR ("project" = '896' AND ("signature" <> 'A' OR "reason" <> 'short close'))
        OR ("project" = 'VS-189' AND ("signature" <> 'A' OR "reason" <> 'short close'))
      )
  `);
  await db.execute(sql`
    UPDATE "order_review_imports"
    SET "override_reason" = 'short close'
    WHERE "override_reason" = 'shourt close'
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "upload_stage_evidence" (
      "id" serial PRIMARY KEY,
      "staging_id" text NOT NULL UNIQUE,
      "staged_at" timestamp with time zone NOT NULL DEFAULT now(),
      "source_filename" text NOT NULL,
      "source_hash" text NOT NULL,
       "kind" text NOT NULL CHECK ("kind" IN ('wip', 'order-review', 'unknown')),
      "report_date" text,
      "compared_against_import_id" integer,
      "blockers" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "warnings" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "assessment" jsonb NOT NULL,
      "details" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "project_codes" jsonb NOT NULL DEFAULT '[]'::jsonb,
       "outcome" text CHECK ("outcome" IN ('imported', 'skipped', 'expired', 'refused')),
      "outcome_at" timestamp with time zone,
       "outcome_reason" text,
      "import_id" integer,
       "import_deleted_at" timestamp with time zone,
       "import_deletion_scope" text,
      "is_reconstruction" boolean NOT NULL DEFAULT false,
      "reconstruction_note" text
    )
  `);
  await db.execute(sql`
    ALTER TABLE "upload_stage_evidence"
      ADD COLUMN IF NOT EXISTS "outcome_reason" text,
      ADD COLUMN IF NOT EXISTS "import_deleted_at" timestamp with time zone,
      ADD COLUMN IF NOT EXISTS "import_deletion_scope" text
  `);
  await db.execute(sql`
    ALTER TABLE "upload_staging"
      ADD COLUMN IF NOT EXISTS "expected_kind" text
        CHECK ("expected_kind" IN ('wip', 'order-review'))
  `);
  await db.execute(sql`
    ALTER TABLE "upload_stage_evidence"
      DROP CONSTRAINT IF EXISTS "upload_stage_evidence_kind_check",
      ADD CONSTRAINT "upload_stage_evidence_kind_check"
        CHECK ("kind" IN ('wip', 'order-review', 'unknown')),
      DROP CONSTRAINT IF EXISTS "upload_stage_evidence_outcome_check",
      ADD CONSTRAINT "upload_stage_evidence_outcome_check"
        CHECK ("outcome" IN ('imported', 'skipped', 'expired', 'refused'))
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "upload_stage_evidence_hash_idx"
    ON "upload_stage_evidence" ("source_hash")
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "upload_stage_evidence_staged_at_idx"
    ON "upload_stage_evidence" ("staged_at" DESC)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "upload_stage_evidence_import_id_idx"
    ON "upload_stage_evidence" ("import_id")
  `);
  logger.info("Order review columns and anomaly register ensured");
}
