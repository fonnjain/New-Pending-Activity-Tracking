import { sql, isNull, and } from "drizzle-orm";
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
 *
 * Order Nature is authoritative: STRUCTURE -> TLT, RSJ POLE/EARTHING/GENERAL ->
 * NTLT (with a section group_key), FOUNDATION BOLT -> NTLT/inactive. Every known
 * nature yields a non-null category, so backfilled rows leave the WHERE set and
 * the loop self-drains.
 *
 * Each batch is written with a SINGLE set-based UPDATE (UPDATE ... FROM (VALUES
 * ...)) rather than one statement per row. The previous per-row version issued
 * ~94k sequential round-trips and never finished within the deploy/instance
 * lifecycle, leaving most NTLT rows null (and thus coalesced to TLT in the UI).
 */
export async function backfillClassification(): Promise<number> {
  const batchSize = 1000;
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
      .where(and(isNull(recordPoolTable.category), KNOWN_NATURES_SQL))
      .orderBy(recordPoolTable.id)
      .limit(batchSize);

    if (rows.length === 0) break;

    const valueRows = rows.map((r) => {
      const { classification: c } = classifyMark({
        orderNature: r.orderNature,
        towerSubType: r.towerSubType,
        section: r.section,
        job: r.job,
      });
      return sql`(${r.id}::int, ${c.category}::text, ${c.ntltSubtype}::text, ${c.groupType}::text, ${c.groupKey}::text, ${c.active}::boolean)`;
    });

    await db.execute(sql`
      update record_pool as rp set
        category = v.category,
        ntlt_subtype = v.ntlt_subtype,
        group_type = v.group_type,
        group_key = v.group_key,
        active = v.active
      from (values ${sql.join(valueRows, sql`, `)})
        as v(id, category, ntlt_subtype, group_type, group_key, active)
      where rp.id = v.id
    `);

    totalUpdated += rows.length;
    logger.info(
      { batch: rows.length, totalUpdated },
      "Backfilling record_pool classification",
    );

    // Backfilled rows now have a non-null category, so they leave the WHERE set
    // on the next pass. A short batch means the backlog is drained.
    if (rows.length < batchSize) break;
  }

  if (totalUpdated > 0) {
    logger.info({ totalUpdated }, "Backfilled record_pool classification");
  }
  return totalUpdated;
}
