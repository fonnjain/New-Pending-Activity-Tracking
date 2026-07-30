import { pgTable, integer, primaryKey, index } from "drizzle-orm/pg-core";
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
  },
  (t) => [
    primaryKey({ columns: [t.importId, t.poolId] }),
    // Standalone index on import_id so Postgres can range-scan efficiently for
    // "WHERE import_id = ?" without a full sequential scan of 1M+ rows.
    index("import_rows_import_id_idx").on(t.importId),
  ],
);

export const insertImportRowSchema = createInsertSchema(importRowsTable);
export type InsertImportRow = z.infer<typeof insertImportRowSchema>;
export type ImportRowMembership = typeof importRowsTable.$inferSelect;
