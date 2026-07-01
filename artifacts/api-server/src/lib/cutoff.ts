import { eq, sql, type SQL } from "drizzle-orm";
import {
  db,
  importsTable,
  settingsTable,
  SETTINGS_SINGLETON_ID,
} from "@workspace/db";

// ---------------------------------------------------------------------------
// Global "valid data starts here" WIP cutoff.
// ---------------------------------------------------------------------------
// A single, persisted, nullable global date in the singleton settings row. When
// set, the WHOLE app — client selection AND every server-side history replay
// (imports list, change log, movement, velocity, milestones, dispatch) —
// considers ONLY WIP imports dated on/after this day; older imports are ignored
// as if they were never uploaded. When NULL (the default), every helper here is
// a no-op, so behaviour is byte-identical to before the feature existed.
//
// Scoping only: this never touches parsing, activity values, qty, dedup/hash
// identity, or ageing math — it only bounds which imports a walk/list observes.
// ---------------------------------------------------------------------------

// The canonical "day" of an import: its report date (YYYY-MM-DD) when present,
// else the UTC calendar day of created_at. Mirrors the importYmd helpers in
// milestones.ts / dispatch.ts and importDateMs in imports.ts so the JS and SQL
// paths agree exactly on which imports fall inside the window.
export function importDayKey(
  reportDate: string | null,
  createdAt: Date | string,
): string {
  if (reportDate && /^\d{4}-\d{2}-\d{2}$/.test(reportDate)) return reportDate;
  const d = createdAt instanceof Date ? createdAt : new Date(createdAt);
  return d.toISOString().slice(0, 10);
}

// A drizzle SQL predicate that keeps only imports on/after the cutoff, using the
// same day definition as importDayKey (report_date, else the UTC day of
// created_at). Returns `undefined` when the cutoff is null so callers can splice
// it into a where clause as a no-op: `.where(cutoffSql(cutoff))` selects all
// rows, and `and(cond, cutoffSql(cutoff))` reduces to just `cond`. This is what
// keeps every call site byte-identical when no cutoff is set.
export function cutoffSql(cutoff: string | null): SQL | undefined {
  if (!cutoff) return undefined;
  return sql`coalesce(${importsTable.reportDate}, (${importsTable.createdAt} at time zone 'UTC')::date) >= ${cutoff}::date`;
}

// Load the current global WIP cutoff (YYYY-MM-DD) or null. Reads the settings
// column directly (already normalized to a date or null by the DB); an absent
// settings row means no cutoff.
export async function loadValidFrom(): Promise<string | null> {
  const [row] = await db
    .select({ validFromDate: settingsTable.validFromDate })
    .from(settingsTable)
    .where(eq(settingsTable.id, SETTINGS_SINGLETON_ID))
    .limit(1);
  const v = row?.validFromDate ?? null;
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
