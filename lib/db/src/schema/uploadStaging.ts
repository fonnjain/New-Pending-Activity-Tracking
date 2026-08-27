import {
  pgTable,
  text,
  date,
  timestamp,
  integer,
  customType,
} from "drizzle-orm/pg-core";

// Postgres bytea <-> Node Buffer. Drizzle has no built-in bytea column type.
const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

// A raw uploaded file held BEFORE it is committed to the deterministic engine.
// The gatekeeper flow stages bytes here, lets Claude validate/sanitize, and only
// on user acceptance does commit run parse+merge.
// On a successful commit the row is NOT deleted: it is marked with the created
// import id (committedImportId) so that a duplicate commit (e.g. a proxy/timeout
// retry of a slow commit) is idempotent — it returns the same import instead of
// a misleading "Staged upload not found" failure. Rows are cleaned up on
// discard or by TTL expiry.
export const uploadStagingTable = pgTable("upload_staging", {
  id: text("id").primaryKey(),
  sourceFilename: text("source_filename").notNull(),
  label: text("label"),
  reportDate: date("report_date", { mode: "string" }),
  // The upload slot selected by the user. This is retained only while raw
  // staging bytes exist, so a WIP reset never discards a staged Order Review
  // just because a malformed file cannot be auto-detected.
  expectedKind: text("expected_kind").$type<"wip" | "order-review">(),
  fileData: bytea("file_data").notNull(),
  // Set once this staged file has been committed into an import. Used to make
  // commit idempotent against duplicate/retried requests.
  committedImportId: integer("committed_import_id"),
  // Set once this staged file has been committed as an Order Review ingest (the
  // second file type). Separate id space from committedImportId so order-review
  // commits are independently idempotent against duplicate/retried requests.
  committedOrderReviewImportId: integer("committed_order_review_import_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type UploadStagingRow = typeof uploadStagingTable.$inferSelect;
