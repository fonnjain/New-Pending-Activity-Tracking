import { sql, isNull, and } from "drizzle-orm";
import { db, recordPoolTable } from "@workspace/db";
import { deriveHoleOperation } from "@workspace/domain";
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

/**
 * One-time, idempotent backfill of the (display/report-only) hole-operation
 * columns (`section_type`, `hole_operation`, `hole_operation_source`) on
 * existing record_pool rows that pre-date the feature. The attribute is a pure
 * function of the stored, immutable `section` string (deriveHoleOperation) and
 * is NOT part of the row hash, so this never changes identity, dedup, ageing, or
 * any computed metric — it only lights up punching/drilling sorting/reporting on
 * historical data. Safe to run repeatedly.
 *
 * deriveHoleOperation ALWAYS returns a non-null hole_operation (NOT_SET when not
 * applicable), so every backfilled row leaves the `hole_operation IS NULL` set
 * and the loop self-drains — a no-op on every subsequent boot. Applies to ALL
 * order types (no nature filter), written with a single set-based UPDATE per
 * batch.
 */
export async function backfillHoleOperation(): Promise<number> {
  const batchSize = 1000;
  let totalUpdated = 0;

  for (;;) {
    const rows = await db
      .select({
        id: recordPoolTable.id,
        section: recordPoolTable.section,
      })
      .from(recordPoolTable)
      .where(isNull(recordPoolTable.holeOperation))
      .orderBy(recordPoolTable.id)
      .limit(batchSize);

    if (rows.length === 0) break;

    const valueRows = rows.map((r) => {
      const h = deriveHoleOperation(r.section);
      return sql`(${r.id}::int, ${h.sectionType}::text, ${h.holeOperation}::text, ${h.holeOperationSource}::text)`;
    });

    await db.execute(sql`
      update record_pool as rp set
        section_type = v.section_type,
        hole_operation = v.hole_operation,
        hole_operation_source = v.hole_operation_source
      from (values ${sql.join(valueRows, sql`, `)})
        as v(id, section_type, hole_operation, hole_operation_source)
      where rp.id = v.id
    `);

    totalUpdated += rows.length;
    logger.info(
      { batch: rows.length, totalUpdated },
      "Backfilling record_pool hole operation",
    );

    if (rows.length < batchSize) break;
  }

  if (totalUpdated > 0) {
    logger.info({ totalUpdated }, "Backfilled record_pool hole operation");
  }
  return totalUpdated;
}

/**
 * Idempotent backfill: populate job_card_type for record_pool rows that were
 * parsed before the column existed.  Only touches rows WHERE job_card_type IS
 * NULL; self-draining on every subsequent boot.
 *
 * Derivation rules (in priority order, applied only when job_card_status IS
 * NOT NULL — old-format rows without status stay null and use the legacy proxy):
 *
 *   1. job_card_status = 'INITIAL'
 *        → 'Job Card Not Started'          (U3: Initial only with JCNS)
 *   2. job_card_status = 'Authorized' AND activity = '' (blank)
 *        → 'FG Pending For Dispatch'       (U4: FG always has blank activity)
 *   3. job_card_status = 'Authorized' AND upper(activity) IN ('C','BL','NTF','NTFSW')
 *        → 'Job Card Not Started'          (C = TLT T1; BL/NTF/NTFSW = NTLT-only JCNS)
 *   4. job_card_status = 'Authorized' AND activity not blank AND not in rule-3 set
 *        → 'Job Card WIP'                  (best proxy; G/TS NTLT JCNS is ambiguous
 *                                           in old data without the Type column)
 */
export async function backfillJobCardType(): Promise<number> {
  const [r1, r2, r3, r4] = await Promise.all([
    // Rule 1: Initial → JCNS
    db.execute(sql`
      UPDATE record_pool
         SET job_card_type = 'Job Card Not Started'
       WHERE job_card_type IS NULL
         AND job_card_status = 'INITIAL'
    `),
    // Rule 2: Authorized + blank activity → FG
    db.execute(sql`
      UPDATE record_pool
         SET job_card_type = 'FG Pending For Dispatch'
       WHERE job_card_type IS NULL
         AND job_card_status = 'AUTHORIZED'
         AND (activity IS NULL OR activity = '')
    `),
    // Rule 3: Authorized + unambiguously JCNS activity → JCNS
    db.execute(sql`
      UPDATE record_pool
         SET job_card_type = 'Job Card Not Started'
       WHERE job_card_type IS NULL
         AND job_card_status = 'AUTHORIZED'
         AND upper(activity) IN ('C', 'BL', 'NTF', 'NTFSW')
    `),
    // Rule 4: Authorized + any other non-blank activity → WIP
    db.execute(sql`
      UPDATE record_pool
         SET job_card_type = 'Job Card WIP'
       WHERE job_card_type IS NULL
         AND job_card_status = 'AUTHORIZED'
         AND activity IS NOT NULL
         AND activity != ''
    `),
  ]);

  const updated =
    Number((r1 as { rowCount?: number }).rowCount ?? 0) +
    Number((r2 as { rowCount?: number }).rowCount ?? 0) +
    Number((r3 as { rowCount?: number }).rowCount ?? 0) +
    Number((r4 as { rowCount?: number }).rowCount ?? 0);
  if (updated > 0) {
    logger.info({ updated }, "Backfilled record_pool job_card_type");
  }
  return updated;
}

/**
 * Idempotent backfill: set is_initial_cutting = true for every record_pool row
 * whose job_card_status = 'INITIAL' but whose is_initial_cutting is currently
 * false.  This corrects rows that were parsed before the definition of
 * is_initial_cutting was broadened to cover ALL Status=Initial marks regardless
 * of activity (the old predicate was activity='C' AND status='INITIAL', which
 * missed non-C marks whose Activity column holds a PLANNED, not current, stage).
 *
 * Also resets any rows where is_initial_cutting = true but job_card_status !=
 * 'INITIAL' (shouldn't exist after the 2026-07-21 corrective run, but keeps
 * the invariant tight).
 *
 * Safe: is_initial_cutting is NOT part of the row hash; old-format rows (null
 * job_card_status) are never touched.  Self-draining: after the first run the
 * WHERE clause matches no rows and the function becomes a no-op on every boot.
 */
export async function backfillInitialCutting(): Promise<number> {
  const [r1, r2] = await Promise.all([
    // Stamp true where status says Initial but flag is still false.
    db.execute(sql`
      UPDATE record_pool
         SET is_initial_cutting = true
       WHERE job_card_status = 'INITIAL'
         AND is_initial_cutting = false
    `),
    // Clear any stale trues where status is no longer Initial (safety net).
    db.execute(sql`
      UPDATE record_pool
         SET is_initial_cutting = false
       WHERE job_card_status IS NOT NULL
         AND job_card_status != 'INITIAL'
         AND is_initial_cutting = true
    `),
  ]);
  const updated =
    Number((r1 as { rowCount?: number }).rowCount ?? 0) +
    Number((r2 as { rowCount?: number }).rowCount ?? 0);
  return updated;
}
