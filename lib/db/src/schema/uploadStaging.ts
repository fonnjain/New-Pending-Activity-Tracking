import { pgTable, text, date, timestamp, customType } from "drizzle-orm/pg-core";

// Postgres bytea <-> Node Buffer. Drizzle has no built-in bytea column type.
const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

// A raw uploaded file held BEFORE it is committed to the deterministic engine.
// The gatekeeper flow stages bytes here, lets Claude validate/sanitize, and only
// on user acceptance does commit run parse+merge and delete the staged row.
// Rows are short-lived and cleaned up on commit, discard, or expiry.
export const uploadStagingTable = pgTable("upload_staging", {
  id: text("id").primaryKey(),
  sourceFilename: text("source_filename").notNull(),
  label: text("label"),
  reportDate: date("report_date", { mode: "string" }),
  fileData: bytea("file_data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type UploadStagingRow = typeof uploadStagingTable.$inferSelect;
