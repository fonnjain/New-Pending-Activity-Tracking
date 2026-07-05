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
//   Fabrication WIP Accumulated  = tonnes added every time a mark's Balance
//     Wt, while its identity was AT TS, goes down between two consecutive WIP
//     imports it appears in -- whether it partially reduces while still
//     sitting at TS (some pieces move on) or the identity leaves TS entirely
//     (moves to a later activity, or disappears), which zeroes out its
//     remaining TS balance. TLT projects only (the quality -> galvanising
//     boundary).
//   Galvanizing WIP Accumulated  = tonnes added every time a mark's Balance
//     Wt, while its identity was AT Y, goes down between two consecutive WIP
//     imports it appears in -- a partial reduction while still at Y, or the
//     full remaining balance when the identity leaves Y (moves on or is
//     dispatched/absent). No category restriction.
//
// "Each time" is load-bearing: a mark that re-enters TS/Y and its balance
// goes down again later is counted again -- this is a lifetime *throughput*
// counter (cumulative weight that has ever left the stage), not a net/
// point-in-time balance. Like the milestone and dispatch engines, recompute()
// replays the whole history and rebuilds the stored totals + ledger from
// scratch each time, so it is idempotent and safe to call best-effort after
// every WIP commit/delete. It NEVER mutates WIP parsing, activity, dedup,
// ageing, warning, milestone, or dispatch state.

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
  structure: string;
  category: string | null;
  activity: string | null;
  weightMt: number;
}

interface LedgerEntry {
  project: string;
  structure: string;
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

// Structure-wise rollup of the mark-wise ledger -- the middle tier of the
// mark -> structure -> project hierarchy. `byProject` (above) is itself the
// project-wise rollup of these rows.
export interface AccumulatedWipStructureTotals {
  project: string;
  structure: string;
  fabricationMt: number;
  galvanizingMt: number;
}

export interface AccumulatedWipResult {
  overall: { fabricationMt: number; galvanizingMt: number };
  byProject: AccumulatedWipTotals[];
  byStructure: AccumulatedWipStructureTotals[];
}

// Key used for the structure-level totals map: project + structure.
function structKey(project: string, structure: string): string {
  return `${project}\u0001${structure}`;
}

function toResult(
  totals: Map<string, { fabricationMt: number; galvanizingMt: number }>,
): AccumulatedWipResult {
  const byStructure = Array.from(totals.entries())
    .map(([key, t]) => {
      const [project, structure] = key.split("\u0001");
      return { project, structure, ...t };
    })
    .filter((p) => p.fabricationMt !== 0 || p.galvanizingMt !== 0)
    .sort((a, b) => a.project.localeCompare(b.project) || a.structure.localeCompare(b.structure));

  const projectMap = new Map<string, { fabricationMt: number; galvanizingMt: number }>();
  for (const s of byStructure) {
    let t = projectMap.get(s.project);
    if (!t) {
      t = { fabricationMt: 0, galvanizingMt: 0 };
      projectMap.set(s.project, t);
    }
    t.fabricationMt += s.fabricationMt;
    t.galvanizingMt += s.galvanizingMt;
  }
  const byProject = Array.from(projectMap.entries())
    .map(([project, t]) => ({ project, ...t }))
    .sort((a, b) => a.project.localeCompare(b.project));

  const overall = byProject.reduce(
    (acc, p) => {
      acc.fabricationMt += p.fabricationMt;
      acc.galvanizingMt += p.galvanizingMt;
      return acc;
    },
    { fabricationMt: 0, galvanizingMt: 0 },
  );
  return { overall, byProject, byStructure };
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
  // Keyed by structKey(project, structure) -- the structure-wise rollup of
  // the mark-wise deltas booked below. Project-wise totals are derived from
  // this map afterwards (see toResult).
  const totals = new Map<string, { fabricationMt: number; galvanizingMt: number }>();
  const ledgerEntries: LedgerEntry[] = [];

  const addTotal = (
    project: string,
    structure: string,
    kind: "fabricationMt" | "galvanizingMt",
    deltaMt: number,
  ) => {
    const key = structKey(project, structure);
    let t = totals.get(key);
    if (!t) {
      t = { fabricationMt: 0, galvanizingMt: 0 };
      totals.set(key, t);
    }
    t[kind] += deltaMt;
  };

  for (const imp of imports) {
    const rows = await db
      .select({
        job: recordPoolTable.job,
        structure: recordPoolTable.structure,
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

      // Fabrication WIP: TLT-only. While an identity's LAST recorded state was
      // at TS, any drop in its Balance Wt is accumulated -- whether it's still
      // sitting at TS with a smaller balance (partial completion) or it has
      // moved on to a later activity (its remaining TS balance is now 0).
      // Booked mark-wise (per identity) against the mark's OWN structure --
      // its structure-wise/project-wise totals are the rollup of these events.
      if (before && before.category === "TLT" && before.activity === "TS") {
        const stillAtTs = r.activity === "TS";
        const remainingMt = stillAtTs ? weightMt : 0;
        const deltaMt = before.weightMt - remainingMt;
        if (deltaMt > 0) {
          addTotal(before.job, before.structure, "fabricationMt", deltaMt);
          ledgerEntries.push({
            project: before.job,
            structure: before.structure,
            kind: "fabrication",
            markId: r.markId,
            jobCardNo: r.jobCardNo,
            entryDate: ymd,
            deltaMt,
            importId: imp.id,
          });
        }
      }

      // Galvanizing WIP: same shape, keyed off Y instead of TS. No category
      // restriction.
      if (before && before.activity === "Y") {
        const stillAtY = r.activity === "Y";
        const remainingMt = stillAtY ? weightMt : 0;
        const deltaMt = before.weightMt - remainingMt;
        if (deltaMt > 0) {
          addTotal(before.job, before.structure, "galvanizingMt", deltaMt);
          ledgerEntries.push({
            project: before.job,
            structure: before.structure,
            kind: "galvanizing",
            markId: r.markId,
            jobCardNo: r.jobCardNo,
            entryDate: ymd,
            deltaMt,
            importId: imp.id,
          });
        }
      }

      prev.set(key, { job: r.job, structure: r.structure, category: r.category, activity: r.activity, weightMt });
    }

    // Identities absent from this import entirely: their remaining balance at
    // TS/Y (whichever they were last at) has gone fully to zero.
    for (const [key, st] of prev) {
      if (present.has(key)) continue;
      const [markId, jobCardNo] = key.split("\u0001");
      if (st.activity === "TS" && st.category === "TLT" && st.weightMt > 0) {
        addTotal(st.job, st.structure, "fabricationMt", st.weightMt);
        ledgerEntries.push({
          project: st.job,
          structure: st.structure,
          kind: "fabrication",
          markId,
          jobCardNo: jobCardNo || null,
          entryDate: ymd,
          deltaMt: st.weightMt,
          importId: imp.id,
        });
      }
      if (st.activity === "Y" && st.weightMt > 0) {
        addTotal(st.job, st.structure, "galvanizingMt", st.weightMt);
        ledgerEntries.push({
          project: st.job,
          structure: st.structure,
          kind: "galvanizing",
          markId,
          jobCardNo: jobCardNo || null,
          entryDate: ymd,
          deltaMt: st.weightMt,
          importId: imp.id,
        });
      }
      // Consumed: this identity has left the report entirely, so any later
      // reappearance (a fresh present-row) starts fresh in the loop above.
      prev.delete(key);
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
          structure: e.structure,
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
      .map(([key, t]) => {
        const [project, structure] = key.split("\u0001");
        return {
          project,
          structure,
          fabricationMt: t.fabricationMt,
          galvanizingMt: t.galvanizingMt,
          updatedAt: new Date(),
        };
      });
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
    rows.map((r) => [
      structKey(r.project, r.structure),
      { fabricationMt: r.fabricationMt, galvanizingMt: r.galvanizingMt },
    ]),
  );
  return toResult(totals);
}
