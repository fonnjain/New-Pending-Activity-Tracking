import app from "./app";
import { logger } from "./lib/logger";
import { backfillClassification, backfillHoleOperation } from "./lib/backfill";
import { seedContractorCategories } from "./lib/seedContractorCategories";
import { seedRsjThickness } from "./lib/seedRsjThickness";

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

  // Best-effort, one-time backfill of the derived hole-operation columns on
  // legacy pool rows so punching/drilling sorting + reporting works on historical
  // data. Fire-and-forget; self-draining and idempotent. Never blocks startup.
  backfillHoleOperation().catch((err) => {
    logger.error({ err }, "Hole operation backfill failed");
  });

  // Best-effort, one-time seed of known out-vendor contractor mappings. Fire-
  // and-forget; onConflictDoNothing keeps it idempotent and never overwrites
  // user edits. Never blocks or fails startup.
  seedContractorCategories().catch((err) => {
    logger.error({ err }, "Contractor category seed failed");
  });

  // Best-effort, one-time seed of the known RSJ types -> thickness so the lookup
  // table is populated by default and base-match inheritance works out of the
  // box. Fire-and-forget; onConflictDoNothing keeps it idempotent and never
  // overwrites user edits. Never blocks or fails startup.
  seedRsjThickness().catch((err) => {
    logger.error({ err }, "RSJ thickness seed failed");
  });
});
