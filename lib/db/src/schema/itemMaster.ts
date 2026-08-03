import {
  pgTable,
  text,
  doublePrecision,
  timestamp,
} from "drizzle-orm/pg-core";

// Item Master — VTPL raw-material catalogue imported from the item master XLS.
// Keyed on item_code (text PK). All rows are stored; only rows where
// thickness_mm IS NOT NULL and item_name does not contain "(JW)" are used for
// the thickness lookup. Never truncated on re-upload (UPSERT ON CONFLICT UPDATE).
// Lookup maps are built at server start / cache-miss from this table; the two
// key columns (exact_key, stripped_key) are pre-computed and stored so we can
// spot conflicts without re-running the normaliser on every request.
export const itemMasterTable = pgTable("item_master", {
  // Unique item code from the master (e.g. "RM05010012").
  itemCode: text("item_code").primaryKey(),
  // Raw Item Name string exactly as it appears in the master file.
  itemName: text("item_name").notNull(),
  subGroup: text("sub_group"),
  groupName: text("group_name"),
  category: text("category"),
  grade: text("grade"),
  sectionWtMmM2: doublePrecision("section_wt_mm_m2"),
  // Galvanizing wall-thickness (mm). NULL means the master doesn't specify one.
  thicknessMm: doublePrecision("thickness_mm"),
  // Pre-computed lookup keys (stored for diagnostics / conflict detection).
  // exact_key  = trim + uppercase + collapse whitespace (no bracket stripping).
  exactKey: text("exact_key").notNull(),
  // stripped_key = bracket/unit tokens stripped (same rules as cleanRsjGroupKey
  // but without forcing an "RSJ" prefix). Used as a fallback when the WIP
  // Section value doesn't carry the full bracket text the exact key needs.
  strippedKey: text("stripped_key").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ItemMasterRow = typeof itemMasterTable.$inferSelect;
