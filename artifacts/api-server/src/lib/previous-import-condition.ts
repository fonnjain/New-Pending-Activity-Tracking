import { and, eq, lt, or, sql } from "drizzle-orm";
import { importsTable } from "@workspace/db";

/**
 * Build the existing "previous import" ordering predicate without passing a
 * nullable report date into Drizzle's typed comparison helpers.
 *
 * A legacy import with no report date previously matched no predecessor
 * because SQL comparisons against NULL are not true. Keep that behavior while
 * making the null case explicit and type-safe.
 */
export function hasReportDate(reportDate: string | null): reportDate is string {
  return reportDate !== null;
}

export function previousImportCondition(reportDate: string | null, id: number) {
  if (!hasReportDate(reportDate)) return sql`false`;

  return or(
    lt(importsTable.reportDate, reportDate),
    and(
      eq(importsTable.reportDate, reportDate),
      lt(importsTable.id, id),
    ),
  );
}