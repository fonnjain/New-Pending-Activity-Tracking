import { pgTable, integer, text, primaryKey, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { importsTable } from "./imports";
import { recordPoolTable } from "./recordPool";

// Membership of pool rows in a given import, with a multiplicity (`copies`)
// that preserves in-sheet duplicate rows as distinct pending units.
export const importRowsTable = pgTable(
  "import_rows",
  {
    importId: integer("import_id")
      .notNull()
      .references(() => importsTable.id, { onDelete: "cascade" }),
    poolId: integer("pool_id")
      .notNull()
      .references(() => recordPoolTable.id),
    copies: integer("copies").notNull(),
    // Per-import snapshot of Col G (Job Card Status) — "INITIAL" | "AUTHORIZED" | null.
    // Null for imports uploaded before this column was added (old-format WIP files
    // that predate the Type/Status columns) and for any pool row that had no Status
    // in the parsed file.  Stored per-import so that a newer upload that changes a
    // mark's status (INITIAL→AUTHORIZED) does NOT retroactively corrupt views of
    // older imports — the pool-level job_card_status would be overwritten, but
    // import_rows.job_card_status always reflects the value from THIS import's file.
    jobCardStatus: text("job_card_status"),
    // Per-import snapshot of Col A (Job Card Type) — "Job Card Not Started" |
    // "Job Card WIP" | "FG Pending For Dispatch" | null.  Same isolation guarantee
    // as job_card_status above.  Null for pre-migration imports.
    jobCardType: text("job_card_type"),
  },
  (t) => [
    primaryKey({ columns: [t.importId, t.poolId] }),
    // Standalone index on import_id so Postgres can range-scan efficiently for
    // "WHERE import_id = ?" without a full sequential scan of 1M+ rows.
    index("import_rows_import_id_idx").on(t.importId),
    // Supports pool-centric joins and lookups without scanning every import.
    index("import_rows_pool_id_idx").on(t.poolId),
  ],
);

export const insertImportRowSchema = createInsertSchema(importRowsTable);
export type InsertImportRow = z.infer<typeof insertImportRowSchema>;
export type ImportRowMembership = typeof importRowsTable.$inferSelect;
