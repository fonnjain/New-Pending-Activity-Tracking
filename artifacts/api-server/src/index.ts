import app from "./app";
import { logger } from "./lib/logger";
import { backfillClassification } from "./lib/backfill";
import { seedContractorCategories } from "./lib/seedContractorCategories";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Best-effort, one-time backfill of classification on legacy pool rows so the
  // TLT/NTLT views light up on historical data. Fire-and-forget; never blocks or
  // fails startup (a no-op once there are no unclassified known-nature rows).
  backfillClassification().catch((err) => {
    logger.error({ err }, "Classification backfill failed");
  });

  // Best-effort, one-time seed of known out-vendor contractor mappings. Fire-
  // and-forget; onConflictDoNothing keeps it idempotent and never overwrites
  // user edits. Never blocks or fails startup.
  seedContractorCategories().catch((err) => {
    logger.error({ err }, "Contractor category seed failed");
  });
});
