import { db, contractorCategoriesTable } from "@workspace/db";
import {
  CONTRACTOR_CATEGORY_SEED,
  normalizeContractorName,
} from "@workspace/domain";
import { logger } from "./logger";

/**
 * One-time, idempotent seed of the known out-vendor contractor mappings (with
 * their FAB/GALVA tags). Inserted with onConflictDoNothing on the normalized
 * name key, so any user edit made in-app ALWAYS wins and re-running on every
 * boot is a no-op. CNC / Sub-contractor are deliberately NOT seeded — they
 * start Unclassified and are set in-app. This is config only: it never touches
 * parsing, ageing, dedup, qty, or the row hash.
 */
export async function seedContractorCategories(): Promise<number> {
  const values = CONTRACTOR_CATEGORY_SEED.map((s) => ({
    nameKey: normalizeContractorName(s.name),
    displayName: s.name,
    category: s.category,
    outVendorType: s.outVendorType as string[],
    // plantLocation is optional in seed; undefined → column default (null)
    ...(s.plantLocation != null ? { plantLocation: s.plantLocation } : {}),
  }));

  if (values.length === 0) return 0;

  const inserted = await db
    .insert(contractorCategoriesTable)
    .values(values)
    .onConflictDoNothing({ target: contractorCategoriesTable.nameKey })
    .returning({ nameKey: contractorCategoriesTable.nameKey });

  if (inserted.length > 0) {
    logger.info(
      { inserted: inserted.length },
      "Seeded contractor sub-categories",
    );
  }
  return inserted.length;
}
