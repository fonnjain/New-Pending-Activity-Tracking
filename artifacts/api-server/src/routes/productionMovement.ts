import { Router } from "express";
import { eq, lt, desc, inArray } from "drizzle-orm";
import {
  db,
  importsTable,
  importRowsTable,
  recordPoolTable,
  type ParseSummary,
} from "@workspace/db";
import { GetImportMovementParams } from "@workspace/api-zod";

const router = Router();

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
  orderNature: string | null;
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
    .where(lt(importsTable.id, target.id))
    .orderBy(desc(importsTable.id))
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
    if (!ex) {
      stateMap.set(markKey, { contractor: con, balanceWt: r.balanceWt });
    } else {
      // Same mark-key, multiple copies: same contractor, sum weights.
      stateMap.set(markKey, { contractor: ex.contractor, balanceWt: ex.balanceWt + r.balanceWt });
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
    .where(lt(importsTable.id, target.id))
    .orderBy(desc(importsTable.id))
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
      orderNature: recordPoolTable.orderNature,
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
    // Cutting output: TLT marks only (orderNature === "Structure")
    // Key each mark as job + \x00 + alias + \x00 + markNo (prompt spec).
    // -----------------------------------------------------------------------

    // Build curr TLT state: key → { activity (uppercase), balanceWt (summed for copies) }
    const currState = new Map<string, { activity: string; balanceWt: number }>();
    for (const r of currRows) {
      if (r.orderNature !== "Structure") continue;
      const act = (r.activity ?? "").trim().toUpperCase();
      const key = `${r.job}\x00${r.alias ?? ""}\x00${r.markNo}`;
      const ex = currState.get(key);
      if (!ex) {
        currState.set(key, { activity: act, balanceWt: r.balanceWt });
      } else if (act === ex.activity) {
        // Same activity: sum weights (copies in the same import)
        currState.set(key, { activity: act, balanceWt: ex.balanceWt + r.balanceWt });
      } else if (ex.activity === "C") {
        // Current entry is C but another row has a further activity → no longer at C
        currState.set(key, { activity: act, balanceWt: r.balanceWt });
      }
      // Otherwise: existing entry already beyond C, keep it.
    }

    // Build prev TLT C-marks: key → total balanceWt (sum copies)
    const prevCMarks = new Map<string, number>();
    for (const r of prevRows) {
      if (r.orderNature !== "Structure") continue;
      if ((r.activity ?? "").trim().toUpperCase() !== "C") continue;
      const key = `${r.job}\x00${r.alias ?? ""}\x00${r.markNo}`;
      prevCMarks.set(key, (prevCMarks.get(key) ?? 0) + r.balanceWt);
    }

    let cuttingOutputKg = 0;
    let cuttingMarksLeft = 0;
    let cuttingMarksReduced = 0;

    for (const [key, prevWtKg] of prevCMarks) {
      const cs = currState.get(key);
      if (!cs || cs.activity !== "C") {
        // Mark left C entirely (advanced or left WIP) → full previous balance is output.
        cuttingOutputKg += prevWtKg;
        cuttingMarksLeft++;
      } else {
        // Still at C — only weight REDUCTION counts as output.
        const diffKg = prevWtKg - cs.balanceWt;
        if (diffKg > 0) {
          cuttingOutputKg += diffKg;
          cuttingMarksReduced++;
        }
        // Weight unchanged or increased (intake / correction) → excluded.
      }
    }

    // -----------------------------------------------------------------------
    // Net balance delta: all activities, all categories.
    // -----------------------------------------------------------------------
    const prevBal = new Map<string, number>();
    for (const r of prevRows) {
      const act = (r.activity ?? "Unassigned").trim();
      prevBal.set(act, (prevBal.get(act) ?? 0) + r.balanceWt);
    }
    const currBal = new Map<string, number>();
    for (const r of currRows) {
      const act = (r.activity ?? "Unassigned").trim();
      currBal.set(act, (currBal.get(act) ?? 0) + r.balanceWt);
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
