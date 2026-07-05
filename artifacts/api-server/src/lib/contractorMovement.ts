import { asc, eq } from "drizzle-orm";
import {
  db,
  importsTable,
  importRowsTable,
  recordPoolTable,
  contractorMovementTable,
} from "@workspace/db";

// ---------------------------------------------------------------------------
// Contractor Performance engine (additive, deterministic, idempotent)
// ---------------------------------------------------------------------------
// A daily log of how much work (marks + weight) moved from one activity to
// the next, credited to the contractor who performed the FROM activity (the
// one who completed and released that stage). Mirrors the accumulated-WIP /
// computed-dispatch engines: a full id-ASC replay of ALL imports, rebuilding
// the stored ledger from scratch each time (TRUNCATE + reinsert) -- no
// cutoff, no capture-once semantics. A mark that regresses and later
// re-crosses the same activity pair again is counted again.
//
// Movement is detected purely by activity change between the two most recent
// imports an identity appears in (arrival at/departure from the dataset
// entirely -- e.g. dispatch -- is NOT a "move" here; that's covered by the
// dispatch / accumulated-WIP reports).

function identityKey(markId: string, jobCardNo: string | null): string {
  return `${markId}\u0001${jobCardNo ?? ""}`;
}

// The ledger date for an import: its report date (YYYY-MM-DD), else the UTC
// day of created_at. Matches the convention used by accumulatedWip.ts /
// milestones.ts / dispatch.ts.
function importYmd(reportDate: string | null, createdAt: Date | string): string {
  if (reportDate && /^\d{4}-\d{2}-\d{2}$/.test(reportDate)) return reportDate;
  const d = createdAt instanceof Date ? createdAt : new Date(createdAt);
  return d.toISOString().slice(0, 10);
}

interface IdentityState {
  job: string;
  activity: string | null;
  contractor: string | null;
}

interface GroupTotal {
  entryDate: string;
  project: string;
  contractor: string | null;
  fromActivity: string;
  toActivity: string;
  markCount: number;
  weightKg: number;
  importId: number;
}

export interface ContractorMovementEntry {
  date: string;
  project: string;
  contractor: string | null;
  fromActivity: string;
  toActivity: string;
  markCount: number;
  weightKg: number;
}

function groupKey(entryDate: string, project: string, contractor: string | null, from: string, to: string): string {
  return [entryDate, project, contractor ?? "", from, to].join("\u0001");
}

// Deterministically recompute the full contractor-movement ledger from the
// entire import history and persist it. Idempotent; returns the flat list of
// entries (already the report's natural "detail" grain) for direct API use.
export async function recomputeContractorMovement(): Promise<ContractorMovementEntry[]> {
  const imports = await db
    .select({
      id: importsTable.id,
      reportDate: importsTable.reportDate,
      createdAt: importsTable.createdAt,
    })
    .from(importsTable)
    .orderBy(asc(importsTable.id));

  const prev = new Map<string, IdentityState>();
  const groups = new Map<string, GroupTotal>();

  for (const imp of imports) {
    const rows = await db
      .select({
        job: recordPoolTable.job,
        markId: recordPoolTable.markId,
        jobCardNo: recordPoolTable.jobCardNo,
        activity: recordPoolTable.activity,
        contractor: recordPoolTable.contractor,
        balanceWt: recordPoolTable.balanceWt,
        copies: importRowsTable.copies,
      })
      .from(importRowsTable)
      .innerJoin(recordPoolTable, eq(importRowsTable.poolId, recordPoolTable.id))
      .where(eq(importRowsTable.importId, imp.id));

    const ymd = importYmd(imp.reportDate, imp.createdAt);

    for (const r of rows) {
      if (!r.activity || !r.markId) continue;
      const key = identityKey(r.markId, r.jobCardNo);
      const before = prev.get(key);

      if (before && before.activity && before.activity !== r.activity) {
        const weightKg = (r.balanceWt ?? 0) * (r.copies ?? 1);
        const gk = groupKey(ymd, r.job, before.contractor, before.activity, r.activity);
        const g = groups.get(gk);
        if (g) {
          g.markCount += r.copies ?? 1;
          g.weightKg += weightKg;
        } else {
          groups.set(gk, {
            entryDate: ymd,
            project: r.job,
            contractor: before.contractor,
            fromActivity: before.activity,
            toActivity: r.activity,
            markCount: r.copies ?? 1,
            weightKg,
            importId: imp.id,
          });
        }
      }

      prev.set(key, { job: r.job, activity: r.activity, contractor: r.contractor });
    }
  }

  const entries = Array.from(groups.values());

  await db.transaction(async (tx) => {
    await tx.delete(contractorMovementTable);
    const chunk = 500;
    for (let i = 0; i < entries.length; i += chunk) {
      await tx.insert(contractorMovementTable).values(
        entries.slice(i, i + chunk).map((e) => ({
          entryDate: e.entryDate,
          project: e.project,
          contractor: e.contractor,
          fromActivity: e.fromActivity,
          toActivity: e.toActivity,
          markCount: e.markCount,
          weightKg: e.weightKg,
          importId: e.importId,
        })),
      );
    }
  });

  return entries
    .map((e) => ({
      date: e.entryDate,
      project: e.project,
      contractor: e.contractor,
      fromActivity: e.fromActivity,
      toActivity: e.toActivity,
      markCount: e.markCount,
      weightKg: e.weightKg,
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.project.localeCompare(b.project));
}

// Read the persisted ledger without recomputing (cheap read used where a
// recompute has already run elsewhere in the request).
export async function loadContractorMovement(): Promise<ContractorMovementEntry[]> {
  const rows = await db.select().from(contractorMovementTable);
  return rows
    .map((r) => ({
      date: r.entryDate,
      project: r.project,
      contractor: r.contractor,
      fromActivity: r.fromActivity,
      toActivity: r.toActivity,
      markCount: r.markCount,
      weightKg: r.weightKg,
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.project.localeCompare(b.project));
}
