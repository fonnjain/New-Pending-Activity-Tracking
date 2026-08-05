import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

// Additive, idempotent column upgrades for order_review_rows. Runs at startup so
// production picks up new nullable columns without a manual migration step.
export async function ensureOrderReviewColumns(): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "order_review_rows"
    ADD COLUMN IF NOT EXISTS "bal_wo_mt" double precision
  `);
  logger.info("Order review columns ensured");
}
