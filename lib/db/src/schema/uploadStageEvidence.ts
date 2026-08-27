import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export type UploadStageEvidenceKind = "wip" | "order-review" | "unknown";
export type UploadStageEvidenceOutcome = "imported" | "skipped" | "expired" | "refused";

/**
 * Immutable, append-only evidence from the staging panel. This deliberately
 * does not reference imports with a database foreign key: imports can be
 * deleted, while the audit evidence must remain available.
 */
export const uploadStageEvidenceTable = pgTable(
  "upload_stage_evidence",
  {
    id: serial("id").primaryKey(),
    stagingId: text("staging_id").notNull(),
    stagedAt: timestamp("staged_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sourceFilename: text("source_filename").notNull(),
    sourceHash: text("source_hash").notNull(),
    kind: text("kind").$type<UploadStageEvidenceKind>().notNull(),
    reportDate: text("report_date"),
    comparedAgainstImportId: integer("compared_against_import_id"),
    blockers: jsonb("blockers").notNull().default([]),
    warnings: jsonb("warnings").notNull().default([]),
    assessment: jsonb("assessment").notNull(),
    details: jsonb("details").notNull().default({}),
    projectCodes: jsonb("project_codes").notNull().default([]),
    outcome: text("outcome").$type<UploadStageEvidenceOutcome>(),
    outcomeAt: timestamp("outcome_at", { withTimezone: true }),
    outcomeReason: text("outcome_reason"),
    importId: integer("import_id"),
    /** Retained historical link when the import was later deleted. No foreign key. */
    importDeletedAt: timestamp("import_deleted_at", { withTimezone: true }),
    importDeletionScope: text("import_deletion_scope"),
    isReconstruction: boolean("is_reconstruction").notNull().default(false),
    reconstructionNote: text("reconstruction_note"),
  },
  (t) => [
    uniqueIndex("upload_stage_evidence_staging_id_uq").on(t.stagingId),
    index("upload_stage_evidence_hash_idx").on(t.sourceHash),
    index("upload_stage_evidence_staged_at_idx").on(t.stagedAt),
    index("upload_stage_evidence_import_id_idx").on(t.importId),
  ],
);

export type UploadStageEvidenceRow = typeof uploadStageEvidenceTable.$inferSelect;