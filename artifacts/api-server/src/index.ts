import app from "./app";
import { logger } from "./lib/logger";
import { backfillClassification, backfillHoleOperation, backfillInitialCutting } from "./lib/backfill";
import { seedContractorCategories } from "./lib/seedContractorCategories";
import { seedRsjThickness } from "./lib/seedRsjThickness";
import { seedUsersIfEmpty } from "./lib/seedUsers";

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

  // Best-effort, one-time backfill of is_initial_cutting on existing C-activity
  // pool rows. The column was added with DEFAULT false so all rows written before
  // the feature was live read false. Proxy: activity='C' AND assign_date IS NULL
  // AND contractor IS NULL — all Initial marks satisfy this; Authorized marks
  // always have a contractor. Self-draining (runs once then is a no-op).
  backfillInitialCutting().catch((err) => {
    logger.error({ err }, "Initial cutting backfill failed");
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

  // Best-effort seed of all company users from the directory list. Fire-and-
  // forget; skipped if the table already has rows (idempotent check first).
  seedUsersIfEmpty().catch((err) => {
    logger.error({ err }, "User seed failed");
  });
});
