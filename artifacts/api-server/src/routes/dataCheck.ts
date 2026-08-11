import { Router, type IRouter } from "express";
import {
  db,
  importRowsTable,
  recordPoolTable,
  importsTable,
  orderReviewRowsTable,
} from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { QC_ACTIVITY_SET, GALV_ACTIVITY_SET } from "@workspace/domain";
import { loadLatestOrderReview, loadLatestWipImport } from "../lib/dispatch";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DcViolation {
  project: string;
  structure: string;
  fields: Record<string, string | null>;
}

export interface DcHardRule {
  id: string;
  label: string;
  toleranceMt: number;
  structuresEvaluated: number;
  violationCount: number;
  pass: boolean;
  violations: DcViolation[];
}

export interface DcWarning {
  id: string;
  label: string;
  structureCount: number;
  totalMt: number;
  worstProject: string;
  worstStructure: string;
  worstMt: number;
}

export interface DcWipBucket {
  name: string;
  mt: number;
  marks: number;
}

export interface DataCheckResponse {
  available: boolean;
  orImportId: number | null;
  orAsOnDate: string | null;
  wipImportId: number | null;
  /** True when the WIP import has per-row job_card_type data in import_rows.
   * False for pre-type-column imports (ids 5–32): DC6 is not evaluated for
   * those because classifying them would draw from pool COALESCE fallbacks
   * and report a false PASS. */
  wipHasTypeData: boolean;
  structuresEvaluated: number;
  hardRuleFailures: number;
  hardRules: DcHardRule[];
  warnings: DcWarning[];
  wipBuckets: DcWipBucket[];
  wipUnclassifiedMarks: number;
  wipTotalMt: number;
  wipTotalMarks: number;
  dc0StoredTotalRows: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type OrRow = typeof orderReviewRowsTable.$inferSelect;

/** Null-safe number coercion. */
const n = (v: number | null | undefined): number => v ?? 0;
const fmt3 = (v: number | null | undefined): string => (v ?? 0).toFixed(3);

const TOTAL_ROW_RE = /\b(sub\s*total|grand\s*total|total)\b/i;

function dcHardRule(
  id: string,
  label: string,
  toleranceMt: number,
  rows: OrRow[],
  violateFn: (r: OrRow) => boolean,
  fieldsFn: (r: OrRow) => Record<string, string | null>,
  absDiffFn: (r: OrRow) => number,
): DcHardRule {
  const violations = rows
    .filter(violateFn)
    .sort((a, b) => absDiffFn(b) - absDiffFn(a));
  return {
    id,
    label,
    toleranceMt,
    structuresEvaluated: rows.length,
    violationCount: violations.length,
    pass: violations.length === 0,
    violations: violations.map((r) => ({
      project: r.project,
      structure: r.structure,
      fields: fieldsFn(r),
    })),
  };
}

function dcWarning(
  id: string,
  label: string,
  rows: OrRow[],
  violateFn: (r: OrRow) => boolean,
  valueFn: (r: OrRow) => number,
): DcWarning {
  const violating = rows.filter(violateFn);
  const totalMt = violating.reduce((s, r) => s + valueFn(r), 0);
  let worstProject = "";
  let worstStructure = "";
  let worstMt = 0;
  for (const r of violating) {
    const v = valueFn(r);
    if (Math.abs(v) > Math.abs(worstMt)) {
      worstMt = v;
      worstProject = r.project;
      worstStructure = r.structure;
    }
  }
  return {
    id,
    label,
    structureCount: violating.length,
    totalMt,
    worstProject,
    worstStructure,
    worstMt,
  };
}

// ---------------------------------------------------------------------------
// GET /reports/data-check
// ---------------------------------------------------------------------------
router.get("/reports/data-check", async (_req, res): Promise<void> => {
  // Latest WIP import + latest OR in parallel
  const [latestWip, orData] = await Promise.all([
    loadLatestWipImport(),
    loadLatestOrderReview(),
  ]);

  const empty: DataCheckResponse = {
    available: false,
    orImportId: null,
    orAsOnDate: null,
    wipImportId: latestWip?.id ?? null,
    wipHasTypeData: false,
    structuresEvaluated: 0,
    hardRuleFailures: 0,
    hardRules: [],
    warnings: [],
    wipBuckets: [],
    wipUnclassifiedMarks: 0,
    wipTotalMt: 0,
    wipTotalMarks: 0,
    dc0StoredTotalRows: 0,
  };

  if (!orData) {
    res.json(empty);
    return;
  }

  const currentOrRows = orData.rows;
  const currentOrImportId = orData.import.id;

  // -------------------------------------------------------------------------
  // DC0 — stored total-rows check (should be 0 after the parser fix)
  // -------------------------------------------------------------------------
  const dc0Count = currentOrRows.filter((r) => TOTAL_ROW_RE.test(r.structure)).length;

  // -------------------------------------------------------------------------
  // DC1–DC5 — Order Review arithmetic hard rules
  // -------------------------------------------------------------------------

  // DC1: T = L − M  (Balance Fabrication = Release − Fab)
  const r_dc1 = dcHardRule(
    "DC1",
    "Balance Fabrication (T) = Progress Release (L) − Progress Fabrication (M). Tolerance: 2.5 kg.",
    0.0025,
    currentOrRows,
    (r) => Math.abs(n(r.balFabMt) - (n(r.releaseMt) - n(r.fabMt))) > 0.0025,
    (r) => ({
      "T (Bal Fab)":    fmt3(r.balFabMt),
      "L (Release)":    fmt3(r.releaseMt),
      "M (Fab)":        fmt3(r.fabMt),
      "Expected T":     fmt3(n(r.releaseMt) - n(r.fabMt)),
      "Diff (MT)":      (n(r.balFabMt) - (n(r.releaseMt) - n(r.fabMt))).toFixed(3),
    }),
    (r) => Math.abs(n(r.balFabMt) - (n(r.releaseMt) - n(r.fabMt))),
  );

  // DC2: W = O − Q  (Balance Despatch = Inspection − Despatch)
  const r_dc2 = dcHardRule(
    "DC2",
    "Balance Despatch (W) = Progress Inspection (O) − Progress Despatch (Q). Tolerance: 2.5 kg.",
    0.0025,
    currentOrRows,
    (r) => Math.abs(n(r.fileBalDespatchMt) - (n(r.inspectionMt) - n(r.fileDespatchMt))) > 0.0025,
    (r) => ({
      "W (Bal Desp)":   fmt3(r.fileBalDespatchMt),
      "O (Inspection)": fmt3(r.inspectionMt),
      "Q (Despatch)":   fmt3(r.fileDespatchMt),
      "Expected W":     fmt3(n(r.inspectionMt) - n(r.fileDespatchMt)),
      "Diff (MT)":      (n(r.fileBalDespatchMt) - (n(r.inspectionMt) - n(r.fileDespatchMt))).toFixed(3),
    }),
    (r) => Math.abs(n(r.fileBalDespatchMt) - (n(r.inspectionMt) - n(r.fileDespatchMt))),
  );

  // DC3: U = M − N  (Balance Galvanising = Fab − Galv)
  const r_dc3 = dcHardRule(
    "DC3",
    "Balance Galvanising (U) = Progress Fabrication (M) − Progress Galvanising (N). Tolerance: 10 kg.",
    0.010,
    currentOrRows,
    (r) => Math.abs(n(r.balGalvMt) - (n(r.fabMt) - n(r.galvMt))) > 0.010,
    (r) => ({
      "U (Bal Galv)":  fmt3(r.balGalvMt),
      "M (Fab)":       fmt3(r.fabMt),
      "N (Galv)":      fmt3(r.galvMt),
      "Expected U":    fmt3(n(r.fabMt) - n(r.galvMt)),
      "Diff (MT)":     (n(r.balGalvMt) - (n(r.fabMt) - n(r.galvMt))).toFixed(3),
    }),
    (r) => Math.abs(n(r.balGalvMt) - (n(r.fabMt) - n(r.galvMt))),
  );

  // DC4: S = J − L  (Balance Release = WO Qty − Release)
  const r_dc4 = dcHardRule(
    "DC4",
    "Balance Release (S) = WO Order Qty (J) − Progress Release (L). Tolerance: 50 kg (rounding artefact at 3 decimal places).",
    0.050,
    currentOrRows,
    (r) => Math.abs(n(r.fileBalReleaseMt) - (n(r.woOrderQtyMt) - n(r.releaseMt))) > 0.050,
    (r) => ({
      "S (Bal Release)": fmt3(r.fileBalReleaseMt),
      "J (WO Qty)":      fmt3(r.woOrderQtyMt),
      "L (Release)":     fmt3(r.releaseMt),
      "Expected S":      fmt3(n(r.woOrderQtyMt) - n(r.releaseMt)),
      "Diff (MT)":       (n(r.fileBalReleaseMt) - (n(r.woOrderQtyMt) - n(r.releaseMt))).toFixed(3),
    }),
    (r) => Math.abs(n(r.fileBalReleaseMt) - (n(r.woOrderQtyMt) - n(r.releaseMt))),
  );

  // DC5: L ≥ M  (Release ≥ Fabrication)
  const r_dc5 = dcHardRule(
    "DC5",
    "Progress Release (L) ≥ Progress Fabrication (M). A structure cannot have more fabricated than released. Tolerance: 1 kg.",
    0.001,
    currentOrRows,
    (r) => n(r.releaseMt) < n(r.fabMt) - 0.001,
    (r) => ({
      "L (Release)":    fmt3(r.releaseMt),
      "M (Fab)":        fmt3(r.fabMt),
      "Shortfall (MT)": (n(r.fabMt) - n(r.releaseMt)).toFixed(3),
    }),
    (r) => n(r.fabMt) - n(r.releaseMt),
  );

  // -------------------------------------------------------------------------
  // DC6 — WIP six-bucket partition (uses record_pool via latest WIP import)
  // -------------------------------------------------------------------------
  const bucketDefs = [
    "Release",
    "Awaiting Assignment",
    "Cutting",
    "Quality Check",
    "Galvanising",
    "FG (WIP file)",
  ] as const;
  const bucketCounts: Record<string, { mt: number; marks: number }> = Object.fromEntries(
    bucketDefs.map((k) => [k, { mt: 0, marks: 0 }]),
  );
  let wipUnclassifiedMarks = 0;
  let wipTotalMt = 0;
  let wipTotalMarks = 0;

  // DC6 gate: check whether this WIP import has per-row job_card_type stored in
  // import_rows. Old-format imports (ids 5–32) have 100% NULL job_card_type there;
  // classifying them would silently COALESCE from the pool and report a false PASS.
  const wipHasTypeData = latestWip
    ? (
        await db
          .select({ importId: importRowsTable.importId })
          .from(importRowsTable)
          .where(
            and(
              eq(importRowsTable.importId, latestWip.id),
              sql`${importRowsTable.jobCardType} IS NOT NULL`,
            ),
          )
          .limit(1)
      ).length > 0
    : false;

  if (latestWip && wipHasTypeData) {
    // Scoped to TLT only — the six-bucket model is a TLT model; NTLT uses a
    // separate five-stage model (Y is a distinct stage, not FG). Scoping to TLT
    // makes the reported total tie to the 10,723.709 MT / 59,171 marks figure
    // that users see on Overview and Project Wise.
    //
    // Read raw type/status from import_rows only — no COALESCE fallback to pool.
    // Using import_rows columns directly guarantees we classify only what the
    // file actually stored, so an all-NULL import fails DC6 instead of passing.
    const wipRawRows = await db
      .select({
        jobCardType: importRowsTable.jobCardType,
        jobCardStatus: importRowsTable.jobCardStatus,
        contractor: recordPoolTable.contractor,
        activity: recordPoolTable.activity,
        balanceWt: recordPoolTable.balanceWt,
        copies: importRowsTable.copies,
      })
      .from(importRowsTable)
      .innerJoin(recordPoolTable, eq(importRowsTable.poolId, recordPoolTable.id))
      .where(
        and(
          eq(importRowsTable.importId, latestWip.id),
          eq(recordPoolTable.category, "TLT"),
        ),
      );

    for (const r of wipRawRows) {
      const copies = r.copies ?? 1;
      const tp = (r.jobCardType ?? "").trim().toLowerCase();
      const st = (r.jobCardStatus ?? "").trim().toLowerCase();
      const a  = (r.activity ?? "").trim().toUpperCase();
      const wMt = ((r.balanceWt ?? 0) * copies) / 1000;
      wipTotalMt += wMt;
      wipTotalMarks += copies;

      if (tp === "job card not started" && st === "initial") {
        bucketCounts["Release"].mt += wMt;
        bucketCounts["Release"].marks += copies;
      } else if (tp === "job card not started" && st === "authorized") {
        const contr = (r.contractor ?? "").trim();
        if (contr === "") {
          bucketCounts["Awaiting Assignment"].mt += wMt;
          bucketCounts["Awaiting Assignment"].marks += copies;
        } else {
          bucketCounts["Cutting"].mt += wMt;
          bucketCounts["Cutting"].marks += copies;
        }
      } else if (tp === "job card wip" && QC_ACTIVITY_SET.has(a)) {
        bucketCounts["Quality Check"].mt += wMt;
        bucketCounts["Quality Check"].marks += copies;
      } else if (tp === "job card wip" && GALV_ACTIVITY_SET.has(a)) {
        bucketCounts["Galvanising"].mt += wMt;
        bucketCounts["Galvanising"].marks += copies;
      } else if (tp === "fg pending for dispatch") {
        // Classify on Type alone — activity is irrelevant for FG.
        // An FG row with a non-blank activity would land in FG on every other
        // page; requiring a === "" here would spuriously fail DC6 against a
        // correct page.
        bucketCounts["FG (WIP file)"].mt += wMt;
        bucketCounts["FG (WIP file)"].marks += copies;
      } else {
        wipUnclassifiedMarks += copies;
      }
    }
  }

  const wipBuckets: DcWipBucket[] = bucketDefs.map((name) => ({
    name,
    mt: bucketCounts[name].mt,
    marks: bucketCounts[name].marks,
  }));

  const dc6: DcHardRule = wipHasTypeData
    ? {
        id: "DC6",
        label:
          "WIP (TLT only): the six buckets (Release, Awaiting Assignment, Cutting, Quality Check, Galvanising, FG WIP) sum to the total TLT balance with zero unclassified copies. NTLT uses a separate five-stage model and is excluded. Tolerance: 1 kg.",
        toleranceMt: 0.001,
        structuresEvaluated: wipTotalMarks,
        violationCount: wipUnclassifiedMarks,
        pass: wipUnclassifiedMarks === 0,
        violations: [], // drill-down via wipBuckets breakdown instead
      }
    : {
        id: "DC6",
        label:
          `WIP bucket partition — NOT EVALUATED. WIP import ${latestWip?.id != null ? `#${latestWip.id}` : ""} pre-dates per-row job_card_type storage. Classifying it would draw from pool COALESCE fallbacks and report a false PASS. Re-upload the WIP file to enable this check.`,
        toleranceMt: 0.001,
        structuresEvaluated: 0,
        violationCount: 0,
        pass: false,
        violations: [],
      };

  // -------------------------------------------------------------------------
  // DC7–DC11 — Warnings (conditions that occur legitimately; report counts)
  // -------------------------------------------------------------------------

  // DC7: L > J (released beyond WO) — tolerance 10 kg.
  // 1–5 kg excess is weight-per-set rounding noise at 3 decimal places (173
  // structures sit at exactly 1.000 kg over).  At 10 kg the rule flags ~51
  // structures that are genuinely worth investigating; at 1 kg it flags 316
  // (mostly noise); at 0 kg it flags 463 and means nothing.
  const r_dc7 = dcWarning(
    "DC7",
    "Progress Release (L) > WO Order Qty (J) by more than 10 kg — released materially beyond the work order (sub-10 kg excess is weight-per-set rounding noise).",
    currentOrRows,
    (r) => n(r.releaseMt) > n(r.woOrderQtyMt) + 0.010,
    (r) => n(r.releaseMt) - n(r.woOrderQtyMt),
  );

  // DC8: O > N (inspection exceeds galvanising)
  const r_dc8 = dcWarning(
    "DC8",
    "Progress Inspection (O) > Progress Galvanising (N) — more inspected than galvanised.",
    currentOrRows,
    (r) => n(r.inspectionMt) > n(r.galvMt) + 0.001,
    (r) => n(r.galvMt) - n(r.inspectionMt), // signed: negative = excess inspection
  );

  // DC9: Q > O (despatch exceeds inspection)
  const r_dc9 = dcWarning(
    "DC9",
    "Progress Despatch (Q) > Progress Inspection (O) — more dispatched than inspected.",
    currentOrRows,
    (r) => n(r.fileDespatchMt) > n(r.inspectionMt) + 0.001,
    (r) => n(r.inspectionMt) - n(r.fileDespatchMt), // negative = excess despatch
  );

  // DC10: N > M (galvanising exceeds fabrication)
  const r_dc10 = dcWarning(
    "DC10",
    "Progress Galvanising (N) > Progress Fabrication (M) — more galvanised than fabricated.",
    currentOrRows,
    (r) => n(r.galvMt) > n(r.fabMt) + 0.001,
    (r) => n(r.fabMt) - n(r.galvMt), // negative = excess galv
  );


  // DC15: any of L/M/N/O/Q below zero — a progress figure should never be negative.
  // The worst value reported is the most negative figure across all five fields for
  // the worst-offending structure.
  const r_dc15 = dcWarning(
    "DC15",
    "Negative progress value — Progress Release (L), Fabrication (M), Galvanising (N), Inspection (O) or Despatch (Q) is below zero. A progress figure should never be negative.",
    currentOrRows,
    (r) =>
      [r.releaseMt, r.fabMt, r.galvMt, r.inspectionMt, r.fileDespatchMt].some(
        (v) => v != null && v < -0.001,
      ),
    (r) =>
      Math.min(
        n(r.releaseMt),
        n(r.fabMt),
        n(r.galvMt),
        n(r.inspectionMt),
        n(r.fileDespatchMt),
      ),
  );

  // -------------------------------------------------------------------------
  // Assemble response
  // -------------------------------------------------------------------------
  const allHardRules: DcHardRule[] = [r_dc1, r_dc2, r_dc3, r_dc4, r_dc5, dc6];
  const hardRuleFailures = allHardRules.filter((r) => !r.pass).length;

  const response: DataCheckResponse = {
    available: true,
    orImportId: currentOrImportId,
    orAsOnDate: orData.import.asOnDate,
    wipImportId: latestWip?.id ?? null,
    wipHasTypeData,
    structuresEvaluated: currentOrRows.length,
    hardRuleFailures,
    hardRules: allHardRules,
    warnings: [r_dc7, r_dc8, r_dc9, r_dc10, r_dc15],
    wipBuckets,
    wipUnclassifiedMarks,
    wipTotalMt,
    wipTotalMarks,
    dc0StoredTotalRows: dc0Count,
  };

  res.json(response);
});

export default router;
