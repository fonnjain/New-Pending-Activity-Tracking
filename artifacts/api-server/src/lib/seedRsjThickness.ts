import { db, rsjThicknessTable } from "@workspace/db";
import { RSJ_THICKNESS_SEED } from "@workspace/domain";
import { logger } from "./logger";

/**
 * One-time, idempotent seed of the known RSJ types -> galvanizing thickness so
 * the lookup table is populated out of the box and the resolution cascade has
 * exact + base matches to inherit from. Inserted with onConflictDoNothing on the
 * groupKey, so any in-app edit to a seeded value ALWAYS wins and re-running on
 * every boot is a no-op. This is config only: it never touches parsing, ageing,
 * dedup, qty, or the across-upload row hash (thickness is live-resolved).
 */
export async function seedRsjThickness(): Promise<number> {
  const values = RSJ_THICKNESS_SEED.map((s) => ({
    groupKey: s.groupKey.trim().toUpperCase(),
    thicknessMm: s.thicknessMm,
  }));

  if (values.length === 0) return 0;

  const inserted = await db
    .insert(rsjThicknessTable)
    .values(values)
    .onConflictDoNothing({ target: rsjThicknessTable.groupKey })
    .returning({ groupKey: rsjThicknessTable.groupKey });

  if (inserted.length > 0) {
    logger.info({ inserted: inserted.length }, "Seeded RSJ thickness types");
  }
  return inserted.length;
}
