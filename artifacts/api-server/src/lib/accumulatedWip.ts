import { asc, eq } from "drizzle-orm";
import {
  db,
  importsTable,
  importRowsTable,
  recordPoolTable,
  accumulatedWipTable,
  accumulatedWipLedgerTable,
} from "@workspace/db";

// ---------------------------------------------------------------------------
// Accumulated WIP engine (additive, deterministic, idempotent)
// ---------------------------------------------------------------------------
// Two lifetime throughput counters per project, replayed from the FULL WIP
// import history (no cutoff -- these are cumulative "ever produced" totals,
// not a point-in-time balance, mirroring the Computed Dispatch engine):
//
//   Fabrication WIP Accumulated  = tonnes added each time a mark's identity
//     was at TS in one WIP import and at G in the very next one it appears
//     in, TLT projects only (the quality -> galvanising boundary).
//   Galvanizing WIP Accumulated  = tonnes added each time a mark's identity
//     was at Y in a WIP import and is absent from the next one (left Y --
//     dispatched/completed).
//
// "Each time" is load-bearing: a mark that re-enters an earlier activity and
// crosses the same boundary again later is counted again. Like the milestone
// and dispatch engines, recompute() replays the whole history and rebuilds the
// stored totals + ledger from scratch each time, so it is idempotent and safe
// to call best-effort after every WIP commit/delete. It NEVER mutates WIP
// parsing, activity, dedup, ageing, warning, milestone, or dispatch state.

const UNASSIGNED = "(Unassigned)";

function identityKey(markId: string, jobCardNo: string | null): string {
  return `${markId}\u0001${jobCardNo ?? ""}`;
}

// The ledger date for an import: its report date (YYYY-MM-DD), else created_at.
function importYmd(reportDate: string | null, createdAt: Date | string): string {
  if (reportDate && /^\d{4}-\d{2}-\d{2}$/.test(reportDate)) return reportDate;
  const d = createdAt instanceof Date ? createdAt : new Date(createdAt);
  return d.toISOString().slice(0, 10);
}

interface IdentityState {
  job: string;
  category: string | null;
  activity: string | null;
  weightMt: number;
}

interface LedgerEntry {
  project: string;
  kind: "fabrication" | "galvanizing";
  markId: string;
  jobCardNo: string | null;
  entryDate: string;
  deltaMt: number;
  importId: number;
}

export interface AccumulatedWipTotals {
  project: string;
  fabricationMt: number;
  galvanizingMt: number;
}

export interface AccumulatedWipResult {
  overall: { fabricationMt: number; galvanizingMt: number };
  byProject: AccumulatedWipTotals[];
}

function toResult(
  totals: Map<string, { fabricationMt: number; galvanizingMt: number }>,
): AccumulatedWipResult {
  const byProject = Array.from(totals.entries())
    .map(([project, t]) => ({ project, ...t }))
    .filter((p) => p.fabricationMt !== 0 || p.galvanizingMt !== 0)
    .sort((a, b) => a.project.localeCompare(b.project));
  const overall = byProject.reduce(
    (acc, p) => {
      acc.fabricationMt += p.fabricationMt;
      acc.galvanizingMt += p.galvanizingMt;
      return acc;
    },
    { fabricationMt: 0, galvanizingMt: 0 },
  );
  return { overall, byProject };
}

// Deterministically recompute both lifetime accumulated-WIP totals + rebuild
// the audit ledger from the full WIP import history. Idempotent; persists the
// per-project totals and returns them (+ the overall sum) for direct API use.
export async function recomputeAccumulatedWip(): Promise<AccumulatedWipResult> {
  const imports = await db
    .select({
      id: importsTable.id,
      reportDate: importsTable.reportDate,
      createdAt: importsTable.createdAt,
    })
    .from(importsTable)
    .orderBy(asc(importsTable.id));

  const prev = new Map<string, IdentityState>();
  const totals = new Map<string, { fabricationMt: number; galvanizingMt: number }>();
  const ledgerEntries: LedgerEntry[] = [];

  const addTotal = (
    project: string,
    kind: "fabricationMt" | "galvanizingMt",
    deltaMt: number,
  ) => {
    let t = totals.get(project);
    if (!t) {
      t = { fabricationMt: 0, galvanizingMt: 0 };
      totals.set(project, t);
    }
    t[kind] += deltaMt;
  };

  for (const imp of imports) {
    const rows = await db
      .select({
        job: recordPoolTable.job,
        markId: recordPoolTable.markId,
        jobCardNo: recordPoolTable.jobCardNo,
        activity: recordPoolTable.activity,
        category: recordPoolTable.category,
        balanceWt: recordPoolTable.balanceWt,
        copies: importRowsTable.copies,
      })
      .from(importRowsTable)
      .innerJoin(recordPoolTable, eq(importRowsTable.poolId, recordPoolTable.id))
      .where(eq(importRowsTable.importId, imp.id));

    const ymd = importYmd(imp.reportDate, imp.createdAt);
    const present = new Set<string>();

    for (const r of rows) {
      if (r.job === UNASSIGNED) continue;
      const key = identityKey(r.markId, r.jobCardNo);
      present.add(key);
      const weightMt = ((r.balanceWt ?? 0) * (r.copies ?? 1)) / 1000;
      const before = prev.get(key);

      // Fabrication WIP: TLT-only, TS -> G transition between two consecutive
      // WIP imports this identity appears in.
      if (
        before &&
        before.category === "TLT" &&
        r.category === "TLT" &&
        before.activity === "TS" &&
        r.activity === "G"
      ) {
        addTotal(r.job, "fabricationMt", weightMt);
        ledgerEntries.push({
          project: r.job,
          kind: "fabrication",
          markId: r.markId,
          jobCardNo: r.jobCardNo,
          entryDate: ymd,
          deltaMt: weightMt,
          importId: imp.id,
        });
      }

      prev.set(key, { job: r.job, category: r.category, activity: r.activity, weightMt });
    }

    // Galvanizing WIP: an identity at Y in the PREVIOUS import is now absent
    // (left Y -- dispatched/completed). Uses the weight last recorded at Y.
    for (const [key, st] of prev) {
      if (st.activity === "Y" && !present.has(key)) {
        addTotal(st.job, "galvanizingMt", st.weightMt);
        const [markId, jobCardNo] = key.split("\u0001");
        ledgerEntries.push({
          project: st.job,
          kind: "galvanizing",
          markId,
          jobCardNo: jobCardNo || null,
          entryDate: ymd,
          deltaMt: st.weightMt,
          importId: imp.id,
        });
        // Consumed: this identity has left the report entirely, so it can't
        // leave Y again unless it reappears (a fresh present-row overwrites
        // this entry in the loop above on some later import).
        prev.delete(key);
      }
    }
  }

  await db.transaction(async (tx) => {
    await tx.delete(accumulatedWipLedgerTable);
    await tx.delete(accumulatedWipTable);

    const chunk = 500;
    for (let i = 0; i < ledgerEntries.length; i += chunk) {
      await tx.insert(accumulatedWipLedgerTable).values(
        ledgerEntries.slice(i, i + chunk).map((e) => ({
          project: e.project,
          kind: e.kind,
          markId: e.markId,
          jobCardNo: e.jobCardNo,
          entryDate: e.entryDate,
          deltaMt: e.deltaMt,
          importId: e.importId,
        })),
      );
    }

    const upserts = Array.from(totals.entries())
      .filter(([, t]) => t.fabricationMt !== 0 || t.galvanizingMt !== 0)
      .map(([project, t]) => ({
        project,
        fabricationMt: t.fabricationMt,
        galvanizingMt: t.galvanizingMt,
        updatedAt: new Date(),
      }));
    for (let i = 0; i < upserts.length; i += chunk) {
      await tx.insert(accumulatedWipTable).values(upserts.slice(i, i + chunk));
    }
  });

  return toResult(totals);
}

// Read the persisted totals without recomputing (used where a caller wants a
// cheap read after a recompute has already run elsewhere in the request).
export async function loadAccumulatedWip(): Promise<AccumulatedWipResult> {
  const rows = await db.select().from(accumulatedWipTable);
  const totals = new Map<string, { fabricationMt: number; galvanizingMt: number }>(
    rows.map((r) => [r.project, { fabricationMt: r.fabricationMt, galvanizingMt: r.galvanizingMt }]),
  );
  return toResult(totals);
}
