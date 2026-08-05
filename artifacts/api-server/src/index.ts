import app from "./app";
import { logger } from "./lib/logger";
import { ensureContractorDedupTables } from "./lib/ensureContractorDedupTables";
import { backfillClassification, backfillHoleOperation, backfillInitialCutting, backfillJobCardType } from "./lib/backfill";
import { backfillReleaseBalanceFromPool, backfillAssignmentBalanceFromPool } from "./lib/parseWipReleaseBalance";
import { seedContractorCategories } from "./lib/seedContractorCategories";
import { seedRsjThickness } from "./lib/seedRsjThickness";
import { seedUsersIfEmpty } from "./lib/seedUsers";
import { warmMembershipCaches } from "./routes/imports";

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

// Perform required schema setup BEFORE accepting connections so no route
// can run against a database that is missing the contractor dedup tables.
// On databases provisioned via drizzle-kit push this is instant (no-op);
// on a fresh database (e.g. first production deploy) it creates the tables.
async function startServer(): Promise<void> {
  await ensureContractorDedupTables();

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

    // Best-effort backfill: stamp is_initial_cutting = true for all rows whose
    // job_card_status = 'INITIAL' but flag is still false (covers non-C-activity
    // not-released marks missed by the old Activity=C predicate). Self-draining.
    backfillInitialCutting().catch((err) => {
      logger.error({ err }, "Initial-cutting backfill failed");
    });

    // Best-effort backfill: populate job_card_type from stored proxy columns
    // (job_card_status + activity) for rows parsed before the col existed.
    // Self-draining (no-op once all rows with job_card_status set are typed).
    backfillJobCardType().catch((err) => {
      logger.error({ err }, "Job-card-type backfill failed");
    });

    // Best-effort, one-time backfill of the derived hole-operation columns on
    // legacy pool rows so punching/drilling sorting + reporting works on historical
    // data. Fire-and-forget; self-draining and idempotent. Never blocks startup.
    backfillHoleOperation().catch((err) => {
      logger.error({ err }, "Hole operation backfill failed");
    });

    // Best-effort backfill of release_balance_wip for historical imports that
    // have no stored file bytes. Derives figures from record_pool
    // (is_initial_cutting = true AND category = TLT) grouped by import. Safe to
    // run every boot — skips imports that already have rows, so it is idempotent.
    backfillReleaseBalanceFromPool().catch((err) => {
      logger.error({ err }, "Release balance pool backfill failed");
    });

    // Best-effort backfill of assignment_balance_wip for historical imports.
    // Mirrors backfillReleaseBalanceFromPool: skips imports that already have rows,
    // so it is idempotent and self-draining. Runs after backfillInitialCutting so
    // the pool's is_initial_cutting flags are correct before the snapshot is taken.
    backfillAssignmentBalanceFromPool().catch((err) => {
      logger.error({ err }, "Assignment balance pool backfill failed");
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

    // Pre-warm the in-process membership + identity-state caches for all imports
    // so the first user request after a restart (cold-start) is served from cache
    // rather than hitting the raw 1M-row SQL join. Fire-and-forget.
    warmMembershipCaches().catch((err) => {
      logger.error({ err }, "Membership cache warm-up failed");
    });
  });
}

startServer().catch((err) => {
  logger.error({ err }, "Server startup failed");
  process.exit(1);
});
