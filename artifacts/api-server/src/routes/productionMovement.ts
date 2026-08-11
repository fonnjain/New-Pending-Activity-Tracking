import { Router } from "express";
import { eq, lt, desc, inArray, sql, or, and } from "drizzle-orm";
import {
  db,
  importsTable,
  importRowsTable,
  recordPoolTable,
  type ParseSummary,
} from "@workspace/db";
import { GetImportMovementParams } from "@workspace/api-zod";

const router = Router();

// Normalise a raw Excel field for mark-key comparison:
// trim whitespace, strip trailing dots, strip leading dashes, lowercase.
// Matches the join normalisation used everywhere else in the app.
function normKey(s: string | null | undefined): string {
  if (!s) return "";
  return s.trim().replace(/\.+$/, "").replace(/^-+/, "").toLowerCase();
}

function importDayKey(reportDate: string | null, createdAt: Date | string): string {
  if (reportDate && /^\d{4}-\d{2}-\d{2}$/.test(reportDate)) return reportDate;
  const d = createdAt instanceof Date ? createdAt : new Date(createdAt);
  return d.toISOString().slice(0, 10);
}

const MONTH = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function buildDayLabel(currKey: string, prevKey: string, elapsed: number): string {
  const c = new Date(currKey + "T00:00:00Z");
  const p = new Date(prevKey + "T00:00:00Z");
  if (elapsed <= 1) return `${c.getUTCDate()} ${MONTH[c.getUTCMonth()]}`;
  return `${p.getUTCDate()}-${c.getUTCDate()} ${MONTH[c.getUTCMonth()]} (${elapsed}d)`;
}

type MarkRow = {
  importId: number;
  job: string;
  alias: string | null;
  markNo: string;
  activity: string | null;
  balanceWt: number;
  copies: number | null;
  orderNature: string | null;
  isInitialCutting: boolean | null;
};

// GET /imports/:id/contractor-movement
// Mark-level per-contractor balance movement across consecutive imports (TLT only).
router.get("/imports/:id/contractor-movement", async (req, res): Promise<void> => {
  const params = GetImportMovementParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [target] = await db
    .select({
      id: importsTable.id,
      reportDate: importsTable.reportDate,
      createdAt: importsTable.createdAt,
    })
    .from(importsTable)
    .where(eq(importsTable.id, params.data.id));

  if (!target) {
    res.status(404).json({ error: "Import not found" });
    return;
  }

  const predecessors = await db
    .select({
      id: importsTable.id,
      reportDate: importsTable.reportDate,
      createdAt: importsTable.createdAt,
    })
    .from(importsTable)
    .where(or(
      lt(importsTable.reportDate, target.reportDate),
      and(eq(importsTable.reportDate, target.reportDate), lt(importsTable.id, target.id)),
    ))
    .orderBy(sql`${importsTable.reportDate} DESC NULLS LAST`, desc(importsTable.id))
    .limit(7);

  const allImports = [target, ...predecessors];
  if (allImports.length < 2) {
    res.json({ days: [] });
    return;
  }

  const allIds = allImports.map((i) => i.id);

  type ConMarkRow = {
    importId: number;
    job: string;
    alias: string | null;
    markNo: string;
    contractor: string | null;
    balanceWt: number;
    copies: number | null;
    orderNature: string | null;
  };

  const rawRows: ConMarkRow[] = await db
    .select({
      importId: importRowsTable.importId,
      job: recordPoolTable.job,
      alias: recordPoolTable.alias,
      markNo: recordPoolTable.markNo,
      contractor: recordPoolTable.contractor,
      balanceWt: recordPoolTable.balanceWt,
      copies: importRowsTable.copies,
      orderNature: recordPoolTable.orderNature,
    })
    .from(importRowsTable)
    .innerJoin(recordPoolTable, eq(importRowsTable.poolId, recordPoolTable.id))
    .where(inArray(importRowsTable.importId, allIds));

  // Group by importId, keeping only TLT rows (orderNature = "Structure").
  // Per mark-key (job|alias|markNo), aggregate balanceWt (sum copies) and pick contractor.
  type ConMarkState = { contractor: string; balanceWt: number };

  const byImportCon = new Map<number, Map<string, ConMarkState>>();
  for (const r of rawRows) {
    if (r.orderNature !== "Structure") continue;
    const markKey = `${r.job}\x00${r.alias ?? ""}\x00${r.markNo}`;
    const con = r.contractor?.trim() || "(Unassigned)";
    if (!byImportCon.has(r.importId)) byImportCon.set(r.importId, new Map());
    const stateMap = byImportCon.get(r.importId)!;
    const ex = stateMap.get(markKey);
    const wt = r.balanceWt * (r.copies ?? 1);
    if (!ex) {
      stateMap.set(markKey, { contractor: con, balanceWt: wt });
    } else {
      // Same mark-key, multiple copies: same contractor, sum weights.
      stateMap.set(markKey, { contractor: ex.contractor, balanceWt: ex.balanceWt + wt });
    }
  }

  type ConMeasures = {
    produced: number;
    received: number;
    released: number;
    newIntake: number;
    netChange: number;
  };

  const days = [];

  for (let i = 0; i < allImports.length - 1; i++) {
    const curr = allImports[i];
    const prev = allImports[i + 1];

    const currKey = importDayKey(curr.reportDate, curr.createdAt);
    const prevKey = importDayKey(prev.reportDate, prev.createdAt);
    const elapsed = Math.round(
      (Date.parse(currKey + "T00:00:00Z") - Date.parse(prevKey + "T00:00:00Z")) / 86_400_000,
    );

    const currState = byImportCon.get(curr.id) ?? new Map<string, ConMarkState>();
    const prevState = byImportCon.get(prev.id) ?? new Map<string, ConMarkState>();

    // Accumulators (kg)
    const producedKg = new Map<string, number>();
    const receivedKg = new Map<string, number>();
    const releasedKg = new Map<string, number>();
    const newIntakeKg = new Map<string, number>();

    const add = (map: Map<string, number>, key: string, val: number) =>
      map.set(key, (map.get(key) ?? 0) + val);

    // All mark keys across both imports
    const allKeys = new Set([...prevState.keys(), ...currState.keys()]);

    for (const markKey of allKeys) {
      const pEntry = prevState.get(markKey);
      const cEntry = currState.get(markKey);

      if (pEntry && cEntry) {
        if (pEntry.contractor === cEntry.contractor) {
          // Same contractor: weight reduction = produced, weight increase = ignored (correction)
          const diff = pEntry.balanceWt - cEntry.balanceWt;
          if (diff > 0) add(producedKg, pEntry.contractor, diff);
          // diff < 0 is an increase (correction) — excluded from produced per spec
        } else {
          // Contractor changed: released from prev, received by curr
          add(releasedKg, pEntry.contractor, pEntry.balanceWt);
          add(receivedKg, cEntry.contractor, cEntry.balanceWt);
        }
      } else if (pEntry && !cEntry) {
        // Mark fully left WIP → full previous weight = produced by that contractor
        add(producedKg, pEntry.contractor, pEntry.balanceWt);
      } else if (!pEntry && cEntry) {
        // New mark: new intake for current contractor
        add(newIntakeKg, cEntry.contractor, cEntry.balanceWt);
      }
    }

    // Net change: sum(curr balanceWt for con) − sum(prev balanceWt for con) in kg
    const currTotKg = new Map<string, number>();
    for (const { contractor, balanceWt } of currState.values())
      add(currTotKg, contractor, balanceWt);
    const prevTotKg = new Map<string, number>();
    for (const { contractor, balanceWt } of prevState.values())
      add(prevTotKg, contractor, balanceWt);

    const allCons = new Set([...currTotKg.keys(), ...prevTotKg.keys()]);

    const contractors: Record<string, ConMeasures> = {};
    for (const con of allCons) {
      contractors[con] = {
        produced:   Math.max(0, (producedKg.get(con)  ?? 0) / 1000),
        received:   (receivedKg.get(con)  ?? 0) / 1000,
        released:   (releasedKg.get(con)  ?? 0) / 1000,
        newIntake:  (newIntakeKg.get(con) ?? 0) / 1000,
        netChange:  ((currTotKg.get(con) ?? 0) - (prevTotKg.get(con) ?? 0)) / 1000,
      };
    }

    days.push({
      importId: curr.id,
      dayKey: currKey,
      dayLabel: buildDayLabel(currKey, prevKey, elapsed),
      prevImportId: prev.id,
      prevDayKey: prevKey,
      isGap: elapsed > 1,
      elapsedDays: elapsed,
      contractors,
    });
  }

  days.reverse(); // chronological: oldest first
  res.json({ days });
});

// GET /imports/:id/production-movement
// Returns per-consecutive-pair cutting output (mark-level TLT) + net balance delta.
router.get("/imports/:id/production-movement", async (req, res): Promise<void> => {
  const params = GetImportMovementParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [target] = await db
    .select({
      id: importsTable.id,
      reportDate: importsTable.reportDate,
      createdAt: importsTable.createdAt,
      summary: importsTable.summary,
    })
    .from(importsTable)
    .where(eq(importsTable.id, params.data.id));

  if (!target) {
    res.status(404).json({ error: "Import not found" });
    return;
  }

  // Load up to 7 predecessors (newest first) to compute up to 7 day-deltas.
  const predecessors = await db
    .select({
      id: importsTable.id,
      reportDate: importsTable.reportDate,
      createdAt: importsTable.createdAt,
      summary: importsTable.summary,
    })
    .from(importsTable)
    .where(or(
      lt(importsTable.reportDate, target.reportDate),
      and(eq(importsTable.reportDate, target.reportDate), lt(importsTable.id, target.id)),
    ))
    .orderBy(sql`${importsTable.reportDate} DESC NULLS LAST`, desc(importsTable.id))
    .limit(7);

  // allImports = [newest, ..., oldest]
  const allImports = [target, ...predecessors];

  if (allImports.length < 2) {
    res.json({ days: [] });
    return;
  }

  const allIds = allImports.map((i) => i.id);

  // Batch-load minimal mark data for all imports in a single query.
  const markRows: MarkRow[] = await db
    .select({
      importId: importRowsTable.importId,
      job: recordPoolTable.job,
      alias: recordPoolTable.alias,
      markNo: recordPoolTable.markNo,
      activity: recordPoolTable.activity,
      balanceWt: recordPoolTable.balanceWt,
      copies: importRowsTable.copies,
      orderNature: recordPoolTable.orderNature,
      // Per-import status takes precedence; fall back to pool flag for pre-migration imports.
      isInitialCutting: sql<boolean>`COALESCE(upper(${importRowsTable.jobCardStatus}) = 'INITIAL', ${recordPoolTable.isInitialCutting}, false)`,
    })
    .from(importRowsTable)
    .innerJoin(recordPoolTable, eq(importRowsTable.poolId, recordPoolTable.id))
    .where(inArray(importRowsTable.importId, allIds));

  // Group mark rows by importId.
  const byImport = new Map<number, MarkRow[]>();
  for (const r of markRows) {
    const arr = byImport.get(r.importId);
    if (arr) arr.push(r);
    else byImport.set(r.importId, [r]);
  }

  const days = [];

  for (let i = 0; i < allImports.length - 1; i++) {
    const curr = allImports[i];
    const prev = allImports[i + 1];

    const currKey = importDayKey(curr.reportDate, curr.createdAt);
    const prevKey = importDayKey(prev.reportDate, prev.createdAt);

    const elapsed = Math.round(
      (Date.parse(currKey + "T00:00:00Z") - Date.parse(prevKey + "T00:00:00Z")) /
        86_400_000,
    );
    const isGap = elapsed > 1;

    const currRows = byImport.get(curr.id) ?? [];
    const prevRows = byImport.get(prev.id) ?? [];

    // -----------------------------------------------------------------------
    // Cutting output: TLT marks only (orderNature === "Structure"),
    // excluding is_initial_cutting marks throughout.
    //
    // Algorithm: compare the C-activity balance per normalised mark key between
    // the two imports.  A mark key can appear at BOTH C and a further activity
    // in the same import (split work-orders / batches), so we must not infer
    // "mark left C" from the presence of a non-C row — we only look at how much
    // C-balance the key shed between imports.
    //
    // output per key = max(0, prevCWt − currCWt)
    //   where currCWt = 0 when the key has no C rows at all (advanced or left WIP).
    // -----------------------------------------------------------------------

    // Build prev C-balance: normalised key → total C-activity balanceWt for prev import.
    const prevCBalance = new Map<string, number>();
    for (const r of prevRows) {
      if (r.orderNature !== "Structure") continue;
      if (r.isInitialCutting) continue;
      if ((r.activity ?? "").trim().toUpperCase() !== "C") continue;
      const key = `${normKey(r.job)}\x00${normKey(r.alias)}\x00${normKey(r.markNo)}`;
      prevCBalance.set(key, (prevCBalance.get(key) ?? 0) + r.balanceWt * (r.copies ?? 1));
    }

    // Build curr C-balance: normalised key → total C-activity balanceWt for curr import.
    const currCBalance = new Map<string, number>();
    for (const r of currRows) {
      if (r.orderNature !== "Structure") continue;
      if (r.isInitialCutting) continue;
      if ((r.activity ?? "").trim().toUpperCase() !== "C") continue;
      const key = `${normKey(r.job)}\x00${normKey(r.alias)}\x00${normKey(r.markNo)}`;
      currCBalance.set(key, (currCBalance.get(key) ?? 0) + r.balanceWt * (r.copies ?? 1));
    }

    let cuttingOutputKg = 0;
    let cuttingMarksLeft = 0;
    let cuttingMarksReduced = 0;

    for (const [key, prevWtKg] of prevCBalance) {
      const currWtKg = currCBalance.get(key) ?? 0;
      const diffKg = prevWtKg - currWtKg;
      if (diffKg <= 0) continue; // weight unchanged or increased → no output
      cuttingOutputKg += diffKg;
      if (currWtKg === 0) {
        // No C-balance remaining → mark left C entirely (advanced or left WIP).
        cuttingMarksLeft++;
      } else {
        // Still has C-balance but lighter → partial output from this mark.
        cuttingMarksReduced++;
      }
    }

    // -----------------------------------------------------------------------
    // Net balance delta: all activities, all categories.
    // -----------------------------------------------------------------------
    const prevBal = new Map<string, number>();
    for (const r of prevRows) {
      const act = (r.activity ?? "Unassigned").trim();
      prevBal.set(act, (prevBal.get(act) ?? 0) + r.balanceWt * (r.copies ?? 1));
    }
    const currBal = new Map<string, number>();
    for (const r of currRows) {
      const act = (r.activity ?? "Unassigned").trim();
      currBal.set(act, (currBal.get(act) ?? 0) + r.balanceWt * (r.copies ?? 1));
    }

    const allActs = new Set([...prevBal.keys(), ...currBal.keys()]);
    const netBalance: Record<string, number> = {};
    for (const act of allActs) {
      netBalance[act] = ((currBal.get(act) ?? 0) - (prevBal.get(act) ?? 0)) / 1000;
    }

    // FG net balance from parseSummary.fgWipByJob (kg → MT)
    const fgOf = (summary: ParseSummary | null): number =>
      Object.values(summary?.fgWipByJob ?? {}).reduce((s, v) => s + v, 0);
    netBalance["FG"] = (fgOf(curr.summary) - fgOf(prev.summary)) / 1000;

    days.push({
      importId: curr.id,
      dayKey: currKey,
      dayLabel: buildDayLabel(currKey, prevKey, elapsed),
      prevImportId: prev.id,
      prevDayKey: prevKey,
      isGap,
      elapsedDays: elapsed,
      cuttingOutputMt: cuttingOutputKg / 1000,
      cuttingMarksLeft,
      cuttingMarksReduced,
      netBalance,
    });
  }

  // Return chronological (oldest first) — UI renders left→right as time passes.
  days.reverse();
  res.json({ days });
});

export default router;
