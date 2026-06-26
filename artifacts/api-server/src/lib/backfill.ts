import { sql, isNull, and, eq } from "drizzle-orm";
import { db, recordPoolTable } from "@workspace/db";
import { classifyMark } from "./parse";
import { logger } from "./logger";

// Order Nature values that classifyMark resolves to a NON-null category. Rows
// whose Order Nature is blank/unknown legitimately stay category=null, so we
// exclude them from the backfill query — that keeps this a one-time pass (after
// the first run there are no known-nature rows left with a null category, so the
// query returns nothing and the backfill is a no-op on every subsequent boot).
// These are fixed, safe constants (no user input), inlined as a SQL IN list.
const KNOWN_NATURES_SQL = sql`upper(trim(${recordPoolTable.orderNature})) in ('STRUCTURE','RSJ POLE','EARTHING','GENERAL','FOUNDATION BOLT')`;

/**
 * One-time, idempotent backfill of the (display-only) classification columns
 * (`category`, `ntlt_subtype`, `group_type`, `group_key`, `active`) on existing
 * record_pool rows that pre-date the classification feature. Classification is a
 * pure function of stored raw columns (Order Nature / Tower Sub Type / Section /
 * Job) and is NOT part of the row hash, so this never changes identity, dedup,
 * ageing, or any computed metric — it only lights up the TLT/NTLT views on
 * historical data. Safe to run repeatedly.
 */
export async function backfillClassification(): Promise<number> {
  const batchSize = 500;
  let totalUpdated = 0;

  for (;;) {
    const rows = await db
      .select({
        id: recordPoolTable.id,
        orderNature: recordPoolTable.orderNature,
        towerSubType: recordPoolTable.towerSubType,
        section: recordPoolTable.section,
        job: recordPoolTable.job,
      })
      .from(recordPoolTable)
      .where(
        and(isNull(recordPoolTable.category), KNOWN_NATURES_SQL),
      )
      .limit(batchSize);

    if (rows.length === 0) break;

    for (const r of rows) {
      const { classification: c } = classifyMark({
        orderNature: r.orderNature,
        towerSubType: r.towerSubType,
        section: r.section,
        job: r.job,
      });
      await db
        .update(recordPoolTable)
        .set({
          category: c.category,
          ntltSubtype: c.ntltSubtype,
          groupType: c.groupType,
          groupKey: c.groupKey,
          active: c.active,
        })
        .where(eq(recordPoolTable.id, r.id));
    }

    totalUpdated += rows.length;

    // Safety: every selected row had a KNOWN nature, so classifyMark always set
    // a non-null category — they leave the WHERE set on the next pass. A short
    // batch means we have drained the backlog.
    if (rows.length < batchSize) break;
  }

  if (totalUpdated > 0) {
    logger.info({ totalUpdated }, "Backfilled record_pool classification");
  }
  return totalUpdated;
}
