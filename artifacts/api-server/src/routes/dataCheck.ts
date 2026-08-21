import { Router, type IRouter } from "express";
import {
  db,
  importRowsTable,
  recordPoolTable,
  importsTable,
  orderReviewRowsTable,
} from "@workspace/db";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { PROCESS_SEQUENCE, QC_ACTIVITY_SET, GALV_ACTIVITY_SET, classifyNtltStage, classifyDc17 } from "@workspace/domain";
import { hasTypeData, loadLatestOrderReview, loadLatestWipImport } from "../lib/dispatch";
import { type SourceColumnWatchColumn } from "../lib/parse";
import { buildIdentityBridge, identityRawKey } from "../lib/identityBridge";

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

export interface DcTransition {
  from: string;
  to: string;
  count: number;
  weightMt: number;
}

/** Movement computed successfully for a pair of imports with type data. */
export interface DcMarkMovement {
  available: true;
  prevImportId: number;
  currImportId: number;
  prevDate: string;
  currDate: string;
  /** Always "markId+jobCardNo via identityBridge" — explicit so callers know the key space. */
  identityKey: string;
  trackedMarks: number;
  forwardMoves: number;
  /** DC12 — rework: marks whose activity moved backwards (warning, not an error). */
  backwardMoves: number;
  backwardWeightMt: number;
  backwardTransitions: DcTransition[];
  /** DC13 — marks that left Finished Goods (FG is normally terminal). */
  leavingFgCount: number;
  leavingFgWeightMt: number;
  leavingFgTransitions: DcTransition[];
  /** DC14 — marks present in prev but absent in curr before reaching FG. */
  vanishedCount: number;
  vanishedWeightMt: number;
  vanishedByLastActivity: { activity: string; count: number; weightMt: number }[];
}

/** Either import in the pair lacks per-row type data — movement cannot be computed. */
export interface DcMarkMovementGated {
  available: false;
  reason: string;
  prevImportId: number | null;
  currImportId: number;
  prevDate: string | null;
  currDate: string;
}

export type DcMarkMovementResult = DcMarkMovement | DcMarkMovementGated;

// ---------------------------------------------------------------------------
// DC17 — per-structure WO vs WIP gap
// ---------------------------------------------------------------------------

export interface Dc17StructureRow {
  project: string;
  structure: string;
  /** WO Order Qty (OR col J, MT) */
  j: number;
  /** Progress Despatch (OR col Q, MT) */
  q: number;
  /** WIP pending balance (MT) */
  w: number;
  /** gap = J − Q − W (MT, signed) */
  gap: number;
  /** Seven-way classification A–G (see inline comments). */
  category: "A" | "B" | "C" | "D" | "E" | "F" | "G";
}

export interface Dc17Result {
  /** All keys from OR ∪ WIP (full outer join). */
  structuresCompared: number;
  /** Structures within ±50 kg tolerance. */
  structuresClean: number;
  /** Flagged structures sorted by |gap| descending. */
  flagged: Dc17StructureRow[];
  byCategory: Record<string, { count: number; totalMt: number }>;
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
  /** DC16 — NTLT five-stage partition buckets. */
  ntltBuckets: DcWipBucket[];
  ntltUnclassifiedMarks: number;
  ntltTotalMt: number;
  ntltTotalMarks: number;
  dc0StoredTotalRows: number;
  /** DC12–DC14 cross-import movement results. Null when only one import exists. */
  markMovement: DcMarkMovementResult | null;
  /** DC17 — per-structure WO vs WIP gap. Null when no WIP import exists. */
  dc17: Dc17Result | null;
  /** Source Column Watch — descriptive-only snapshot of watched ERP columns.
   * NOT a DC rule: never affects hardRuleFailures or the banner. Null when no
   * WIP import exists. */
  sourceColumnWatch: DcSourceColumnWatch | null;
}

export interface DcSourceColumnWatch {
  currImportId: number;
  currDayKey: string;
  prevImportId: number | null;
  prevDayKey: string | null;
  /** Null = the import predates the per-import snapshot (columns not present). */
  current: SourceColumnWatchColumn[] | null;
  previous: SourceColumnWatchColumn[] | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type OrRow = typeof orderReviewRowsTable.$inferSelect;

/** Null-safe number coercion. */
const n = (v: number | null | undefined): number => v ?? 0;
const fmt3 = (v: number | null | undefined): string => (v ?? 0).toFixed(3);

const TOTAL_ROW_RE = /\b(sub\s*total|grand\s*total|total)\b/i;

/** Returns a YYYY-MM-DD calendar day key for an import, using report_date if set
 *  and falling back to the UTC date of created_at for old-format imports. */
function importDayKey(reportDate: string | null, createdAt: Date | string): string {
  if (reportDate && /^\d{4}-\d{2}-\d{2}$/.test(reportDate)) return reportDate;
  const d = createdAt instanceof Date ? createdAt : new Date(createdAt as string);
  return d.toISOString().slice(0, 10);
}

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
    ntltBuckets: [],
    ntltUnclassifiedMarks: 0,
    ntltTotalMt: 0,
    ntltTotalMarks: 0,
    dc0StoredTotalRows: 0,
    markMovement: null,
    dc17: null,
    sourceColumnWatch: null,
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
  let blankActivityWipMarks = 0;
  let blankActivityWipMt = 0;
  const blankActivityByStructure = new Map<
    string,
    { project: string; structure: string; mt: number }
  >();

  // DC6 gate: delegate to the shared hasTypeData helper (one definition in dispatch.ts).
  const wipHasTypeData = latestWip ? await hasTypeData(latestWip.id) : false;

  // NTLT accumulator variables (DC16).
  const NTLT_STAGE_KEYS = ["notStarted", "ts", "galvanising", "y", "fg"] as const;
  const NTLT_STAGE_LABELS: Record<string, string> = {
    notStarted: "Not Started",
    ts: "TS",
    galvanising: "Galvanising",
    y: "Y",
    fg: "Finished Goods",
  };
  const ntltBucketCounts: Record<string, { mt: number; marks: number }> = Object.fromEntries(
    NTLT_STAGE_KEYS.map((k) => [k, { mt: 0, marks: 0 }]),
  );
  let ntltTotalMt = 0;
  let ntltTotalMarks = 0;

  // Predecessor import for DC12–DC14 (fetched in parallel below if applicable).
  let prevWip: { id: number; reportDate: string | null; createdAt: Date | string } | null = null;

  if (latestWip && wipHasTypeData) {
    // Three parallel queries: TLT rows (DC6), NTLT rows (DC16), predecessor import (DC12–DC14).
    // Read raw type/status from import_rows only — no COALESCE fallback to pool (we've gated).
    const [wipTltRows, wipNtltRows, prevWipArr] = await Promise.all([
      // TLT rows for the six-bucket DC6 partition.
      db.select({
        job: recordPoolTable.job,
        structure: recordPoolTable.structure,
        jobCardType: importRowsTable.jobCardType,
        jobCardStatus: importRowsTable.jobCardStatus,
        contractor: recordPoolTable.contractor,
        activity: recordPoolTable.activity,
        balanceWt: recordPoolTable.balanceWt,
        copies: importRowsTable.copies,
      })
        .from(importRowsTable)
        .innerJoin(recordPoolTable, eq(importRowsTable.poolId, recordPoolTable.id))
        .where(and(eq(importRowsTable.importId, latestWip.id), eq(recordPoolTable.category, "TLT"))),

      // NTLT rows for the five-stage DC16 partition.
      db.select({
        jobCardType: importRowsTable.jobCardType,
        jobCardStatus: importRowsTable.jobCardStatus,
        activity: recordPoolTable.activity,
        contractor: recordPoolTable.contractor,
        balanceWt: recordPoolTable.balanceWt,
        copies: importRowsTable.copies,
      })
        .from(importRowsTable)
        .innerJoin(recordPoolTable, eq(importRowsTable.poolId, recordPoolTable.id))
        .where(and(eq(importRowsTable.importId, latestWip.id), sql`${recordPoolTable.category} != 'TLT'`)),

      // Most-recent predecessor import (same sort as loadLatestWipImport, shifted by one).
      db.select({ id: importsTable.id, reportDate: importsTable.reportDate, createdAt: importsTable.createdAt })
        .from(importsTable)
        .where(
          latestWip.reportDate != null
            ? or(
                lt(importsTable.reportDate, latestWip.reportDate),
                and(eq(importsTable.reportDate, latestWip.reportDate), lt(importsTable.id, latestWip.id)),
              )
            : lt(importsTable.id, latestWip.id),
        )
        .orderBy(sql`${importsTable.reportDate} DESC NULLS LAST`, desc(importsTable.id))
        .limit(1),
    ]);

    prevWip = prevWipArr[0] ?? null;

    // -----------------------------------------------------------------------
    // DC6 — TLT six-bucket partition
    // -----------------------------------------------------------------------
    for (const r of wipTltRows) {
      const copies = r.copies ?? 1;
      const tp = (r.jobCardType ?? "").trim().toLowerCase();
      const st = (r.jobCardStatus ?? "").trim().toLowerCase();
      const a  = (r.activity ?? "").trim().toUpperCase();
      const wMt = ((r.balanceWt ?? 0) * copies) / 1000;
      wipTotalMt += wMt;
      wipTotalMarks += copies;

      if (tp === "job card wip" && a === "") {
        blankActivityWipMarks += copies;
        blankActivityWipMt += wMt;
        const project = r.job || "(Unassigned)";
        const structure = r.structure || "(blank)";
        const key = `${project}\x01${structure}`;
        const existing = blankActivityByStructure.get(key);
        if (existing) {
          existing.mt += wMt;
        } else {
          blankActivityByStructure.set(key, { project, structure, mt: wMt });
        }
      }

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
      } else if (tp === "job card wip" && (a === "" || QC_ACTIVITY_SET.has(a))) {
        bucketCounts["Quality Check"].mt += wMt;
        bucketCounts["Quality Check"].marks += copies;
      } else if (tp === "job card wip" && GALV_ACTIVITY_SET.has(a)) {
        bucketCounts["Galvanising"].mt += wMt;
        bucketCounts["Galvanising"].marks += copies;
      } else if (tp === "fg pending for dispatch") {
        // Classify on Type alone — activity is irrelevant for FG.
        bucketCounts["FG (WIP file)"].mt += wMt;
        bucketCounts["FG (WIP file)"].marks += copies;
      } else {
        wipUnclassifiedMarks += copies;
      }
    }

    // -----------------------------------------------------------------------
    // DC16 — NTLT five-stage partition
    // -----------------------------------------------------------------------
    for (const r of wipNtltRows) {
      const copies = r.copies ?? 1;
      const wMt = ((r.balanceWt ?? 0) * copies) / 1000;
      ntltTotalMt += wMt;
      ntltTotalMarks += copies;
      const stage = classifyNtltStage(r);
      ntltBucketCounts[stage].mt += wMt;
      ntltBucketCounts[stage].marks += copies;
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

  let blankActivityWorst = {
    project: "",
    structure: "",
    mt: 0,
  };
  for (const row of blankActivityByStructure.values()) {
    if (row.mt > blankActivityWorst.mt) blankActivityWorst = row;
  }
  const r_dc18: DcWarning = {
    id: "DC18",
    label:
      `Job Card WIP rows with a blank Activity are assigned to Quality Check as a catch-all. ` +
      `Affected: ${blankActivityWipMarks.toLocaleString("en-US")} mark${blankActivityWipMarks === 1 ? "" : "s"}, ` +
      `${blankActivityWipMt.toFixed(3)} MT. Correct the missing Activity in the ERP source.`,
    structureCount: blankActivityByStructure.size,
    totalMt: blankActivityWipMt,
    worstProject: blankActivityWorst.project,
    worstStructure: blankActivityWorst.structure,
    worstMt: blankActivityWorst.mt,
  };

  // -------------------------------------------------------------------------
  // DC16 — NTLT five-stage partition assembly
  // -------------------------------------------------------------------------
  const ntltBuckets: DcWipBucket[] = NTLT_STAGE_KEYS.map((key) => ({
    name: NTLT_STAGE_LABELS[key],
    mt: ntltBucketCounts[key].mt,
    marks: ntltBucketCounts[key].marks,
  }));
  // classifyNtltStage always returns a valid stage — unclassified is structurally zero.
  const ntltUnclassifiedMarks = 0;

  const dc16: DcHardRule = wipHasTypeData
    ? {
        id: "DC16",
        label:
          "WIP (NTLT only): the five stages (Not Started, TS, Galvanising, Y, Finished Goods) sum to " +
          "the total NTLT balance with zero unclassified copies. NTLT rows carry blank project code and " +
          "alias and cannot be joined to the Order Review — this is a WIP-only check.",
        toleranceMt: 0.001,
        structuresEvaluated: ntltTotalMarks,
        violationCount: ntltUnclassifiedMarks,
        pass: ntltUnclassifiedMarks === 0,
        violations: [],
      }
    : {
        id: "DC16",
        label:
          `WIP NTLT partition — NOT EVALUATED. WIP import ` +
          `${latestWip?.id != null ? `#${latestWip.id}` : ""} pre-dates per-row job_card_type storage. ` +
          `Re-upload the WIP file to enable this check.`,
        toleranceMt: 0.001,
        structuresEvaluated: 0,
        violationCount: 0,
        pass: false,
        violations: [],
      };

  // -------------------------------------------------------------------------
  // DC12–DC14 — cross-import mark movement
  // Uses identityRawKey(markId, jobCardNo) + buildIdentityBridge for continuity.
  // -------------------------------------------------------------------------
  let markMovement: DcMarkMovementResult | null = null;

  if (latestWip && !wipHasTypeData) {
    // Curr import is gated — record why movement cannot be computed.
    markMovement = {
      available: false,
      reason:
        `WIP import #${latestWip.id} pre-dates per-row Type/Status storage. ` +
        `Mark movement cannot be computed.`,
      prevImportId: null,
      currImportId: latestWip.id,
      prevDate: null,
      currDate: importDayKey(latestWip.reportDate, latestWip.createdAt),
    };
  } else if (latestWip && prevWip) {
    const currDayKey = importDayKey(latestWip.reportDate, latestWip.createdAt);
    const prevDayKey = importDayKey(prevWip.reportDate, prevWip.createdAt);

    const prevHasType = await hasTypeData(prevWip.id);
    if (!prevHasType) {
      markMovement = {
        available: false,
        reason:
          `Predecessor import #${prevWip.id} (${prevDayKey}) pre-dates per-row Type/Status storage. ` +
          `Mark movement cannot be computed for the pair #${prevWip.id} → #${latestWip.id}.`,
        prevImportId: prevWip.id,
        currImportId: latestWip.id,
        prevDate: prevDayKey,
        currDate: currDayKey,
      };
    } else {
      // Both imports have type data — run full movement analysis.
      type MvRow = {
        importId: number;
        markId: string;
        jobCardNo: string | null;
        activity: string | null;
        jobCardType: string | null;
        balanceWt: number;
        copies: number | null;
      };
      const mvRawRows: MvRow[] = await db
        .select({
          importId: importRowsTable.importId,
          markId: recordPoolTable.markId,
          jobCardNo: recordPoolTable.jobCardNo,
          activity: recordPoolTable.activity,
          jobCardType: importRowsTable.jobCardType,
          balanceWt: recordPoolTable.balanceWt,
          copies: importRowsTable.copies,
        })
        .from(importRowsTable)
        .innerJoin(recordPoolTable, eq(importRowsTable.poolId, recordPoolTable.id))
        .where(inArray(importRowsTable.importId, [latestWip.id, prevWip.id]));

      const prevRawRows = mvRawRows.filter((r) => r.importId === prevWip!.id);
      const currRawRows = mvRawRows.filter((r) => r.importId === latestWip!.id);

      // Build identity bridge: handle job-card reissue on TLT stage advances.
      const bridges = buildIdentityBridge([prevRawRows, currRawRows]);
      const prevBridge = bridges[0];
      const currBridge = bridges[1];

      // Activity rank for direction detection.
      // FG (Type = "fg pending for dispatch") sits above Y (rank 11) at rank 12.
      // Unknown activity code → rank -1 (direction undetermined, skipped).
      const FG_RANK = PROCESS_SEQUENCE.length; // 12
      function actRank(r: Pick<MvRow, "activity" | "jobCardType">): number {
        if ((r.jobCardType ?? "").trim().toLowerCase() === "fg pending for dispatch") return FG_RANK;
        const act = (r.activity ?? "").trim().toUpperCase();
        const idx = (PROCESS_SEQUENCE as readonly string[]).indexOf(act);
        return idx >= 0 ? idx : -1;
      }
      function actLabel(r: Pick<MvRow, "activity" | "jobCardType">): string {
        if ((r.jobCardType ?? "").trim().toLowerCase() === "fg pending for dispatch") return "FG";
        return (r.activity ?? "").trim().toUpperCase() || "?";
      }

      // Build canonical-key state maps. When a key appears multiple times in one
      // import (copies at different activities), keep the row with the highest
      // copies-weighted raw weight — same mark, dominant activity.
      type MvState = { rank: number; label: string; wt: number; copies: number };
      const prevMap = new Map<string, MvState>();
      const currMap = new Map<string, MvState>();

      for (const r of prevRawRows) {
        const canon = prevBridge.get(identityRawKey(r.markId, r.jobCardNo)) ?? identityRawKey(r.markId, r.jobCardNo);
        const copies = r.copies ?? 1;
        const wt = (r.balanceWt ?? 0) * copies;
        const ex = prevMap.get(canon);
        if (!ex || wt > ex.wt) {
          prevMap.set(canon, { rank: actRank(r), label: actLabel(r), wt, copies });
        }
      }
      for (const r of currRawRows) {
        const canon = currBridge.get(identityRawKey(r.markId, r.jobCardNo)) ?? identityRawKey(r.markId, r.jobCardNo);
        const copies = r.copies ?? 1;
        const wt = (r.balanceWt ?? 0) * copies;
        const ex = currMap.get(canon);
        if (!ex || wt > ex.wt) {
          currMap.set(canon, { rank: actRank(r), label: actLabel(r), wt, copies });
        }
      }

      // Walk prev marks, classify movement.
      let trackedMarks = 0;
      let forwardMoves = 0;
      let backwardMoves = 0;
      let backwardWt = 0;
      const backTransMap = new Map<string, { count: number; wt: number }>();
      let leavingFgCount = 0;
      let leavingFgWt = 0;
      const leavingFgTransMap = new Map<string, { count: number; wt: number }>();
      let vanishedCount = 0;
      let vanishedWt = 0;
      const vanishedActMap = new Map<string, { count: number; wt: number }>();

      for (const [key, prevState] of prevMap) {
        const currState = currMap.get(key);
        if (!currState) {
          // DC14 — mark absent from curr.  If prev was FG, this is a normal dispatch.
          if (prevState.rank < FG_RANK && prevState.rank !== -1) {
            vanishedCount++;
            vanishedWt += prevState.wt;
            const ex = vanishedActMap.get(prevState.label) ?? { count: 0, wt: 0 };
            vanishedActMap.set(prevState.label, { count: ex.count + prevState.copies, wt: ex.wt + prevState.wt });
          }
          continue;
        }

        trackedMarks++;
        if (prevState.rank === -1 || currState.rank === -1) continue; // direction undetermined

        if (currState.rank > prevState.rank) {
          forwardMoves++;
        } else if (currState.rank < prevState.rank) {
          // DC12 — backward move (rework).
          backwardMoves++;
          backwardWt += prevState.wt;
          const tk = `${prevState.label}\u0001${currState.label}`;
          const ex = backTransMap.get(tk) ?? { count: 0, wt: 0 };
          backTransMap.set(tk, { count: ex.count + prevState.copies, wt: ex.wt + prevState.wt });

          // DC13 — specifically leaving Finished Goods.
          if (prevState.rank === FG_RANK) {
            leavingFgCount++;
            leavingFgWt += prevState.wt;
            const exFg = leavingFgTransMap.get(tk) ?? { count: 0, wt: 0 };
            leavingFgTransMap.set(tk, { count: exFg.count + prevState.copies, wt: exFg.wt + prevState.wt });
          }
        }
        // else: same rank (no activity change)
      }

      const toTransitions = (m: Map<string, { count: number; wt: number }>): DcTransition[] =>
        [...m.entries()]
          .map(([k, v]) => {
            const sep = k.indexOf("\u0001");
            return { from: k.slice(0, sep), to: k.slice(sep + 1), count: v.count, weightMt: v.wt / 1000 };
          })
          .sort((a, b) => b.weightMt - a.weightMt);

      markMovement = {
        available: true,
        prevImportId: prevWip.id,
        currImportId: latestWip.id,
        prevDate: prevDayKey,
        currDate: currDayKey,
        identityKey: "markId+jobCardNo via identityBridge",
        trackedMarks,
        forwardMoves,
        backwardMoves,
        backwardWeightMt: backwardWt / 1000,
        backwardTransitions: toTransitions(backTransMap),
        leavingFgCount,
        leavingFgWeightMt: leavingFgWt / 1000,
        leavingFgTransitions: toTransitions(leavingFgTransMap),
        vanishedCount,
        vanishedWeightMt: vanishedWt / 1000,
        vanishedByLastActivity: [...vanishedActMap.entries()]
          .map(([activity, v]) => ({ activity, count: v.count, weightMt: v.wt / 1000 }))
          .sort((a, b) => b.weightMt - a.weightMt),
      };
    }
  }

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
  // DC17 — per-structure gap: J − Q − W  (WO Qty − Despatch − WIP pending)
  // Tolerance: 50 kg (0.050 MT).  Seven categories A–G (evaluate in order,
  // stop at first match):
  //   Positive gap (J−Q−W > +0.05):
  //     A — W=0 & Q=0: not yet in production
  //     B — W=0 & Q>0: left WIP without a despatch record
  //     C — W>0 & Q=0: in production, WIP short of work order
  //     D — W>0 & Q>0: partly shipped, WIP short of remainder
  //   Negative gap (J−Q−W < −0.05):
  //     E — J=0:         marks with no work order
  //     F — |J−Q|≤0.05: fully despatched per OR, WIP still pending
  //     G — else:        shop holds more than the order expects
  // -------------------------------------------------------------------------
  let dc17: Dc17Result | null = null;
  if (latestWip) {
    // Aggregate TLT WIP balance by (job, structure)
    const wipByStruct = await db
      .select({
        job:       recordPoolTable.job,
        structure: recordPoolTable.structure,
        wipMt:     sql<number>`SUM(${recordPoolTable.balanceWt} * ${importRowsTable.copies}) / 1000.0`,
      })
      .from(importRowsTable)
      .innerJoin(recordPoolTable, eq(importRowsTable.poolId, recordPoolTable.id))
      .where(
        and(
          eq(importRowsTable.importId, latestWip.id),
          eq(recordPoolTable.category, "TLT"),
        ),
      )
      .groupBy(recordPoolTable.job, recordPoolTable.structure);

    // WIP map: "\x01"-delimited key → MT  +  set of active TLT project codes
    const wipMap = new Map<string, number>();
    const wipProjectSet = new Set<string>();
    for (const r of wipByStruct) {
      wipMap.set(`${r.job}\x01${r.structure}`, r.wipMt ?? 0);
      if (r.job) wipProjectSet.add(r.job);
    }

    // OR map from currentOrRows — scoped to projects present in the current WIP.
    // The OR table accumulates rows across all historical imports; old projects
    // (no longer in WIP) would inflate category-A counts and the structure total.
    const orMap = new Map<string, { j: number; q: number; project: string; structure: string }>();
    for (const r of currentOrRows) {
      if (!wipProjectSet.has(r.project)) continue; // skip historical OR-only projects
      orMap.set(`${r.project}\x01${r.structure}`, {
        j: r.woOrderQtyMt ?? 0,
        q: r.fileDespatchMt ?? 0,
        project: r.project,
        structure: r.structure,
      });
    }

    const allKeys = new Set([...orMap.keys(), ...wipMap.keys()]);
    const flagged: Dc17StructureRow[] = [];

    for (const key of allKeys) {
      const or  = orMap.get(key);
      const w   = wipMap.get(key) ?? 0;
      const sep = key.indexOf("\x01");
      const project   = key.slice(0, sep);
      const structure = key.slice(sep + 1);
      const j   = or?.j ?? 0;
      const q   = or?.q ?? 0;
      const gap = j - q - w;

      const category = classifyDc17(j, q, w);
      if (category === null) continue; // within tolerance

      flagged.push({ project, structure, j, q, w, gap, category });
    }

    flagged.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));

    const byCategory: Record<string, { count: number; totalMt: number }> = {};
    for (const r of flagged) {
      if (!byCategory[r.category]) byCategory[r.category] = { count: 0, totalMt: 0 };
      byCategory[r.category].count++;
      byCategory[r.category].totalMt += r.gap;
    }

    dc17 = {
      structuresCompared: allKeys.size,
      structuresClean:    allKeys.size - flagged.length,
      flagged,
      byCategory,
    };
  }

  // -------------------------------------------------------------------------
  // Source Column Watch — descriptive only, never a DC rule, never touches
  // hardRuleFailures/the banner. Snapshots are read from imports.summary
  // (captured at parse time) because record_pool values are shared across
  // imports and re-stamped by later files — a live pool join could not
  // reconstruct what an earlier file contained. Summary key missing ⇒ the
  // import predates the snapshot ⇒ "not present in this file".
  let sourceColumnWatch: DcSourceColumnWatch | null = null;
  if (latestWip) {
    // Predecessor fetched independently of the wipHasTypeData gating above so
    // the panel also works when movement checks are unavailable.
    const [prevForWatch] = await db
      .select({
        id: importsTable.id,
        reportDate: importsTable.reportDate,
        createdAt: importsTable.createdAt,
        summary: importsTable.summary,
      })
      .from(importsTable)
      .where(
        latestWip.reportDate != null
          ? or(
              lt(importsTable.reportDate, latestWip.reportDate),
              and(eq(importsTable.reportDate, latestWip.reportDate), lt(importsTable.id, latestWip.id)),
            )
          : lt(importsTable.id, latestWip.id),
      )
      .orderBy(sql`${importsTable.reportDate} DESC NULLS LAST`, desc(importsTable.id))
      .limit(1);

    const snapshotOf = (summary: unknown): SourceColumnWatchColumn[] | null => {
      const s = summary as { sourceColumnWatch?: SourceColumnWatchColumn[] } | null;
      return Array.isArray(s?.sourceColumnWatch) ? s.sourceColumnWatch : null;
    };

    sourceColumnWatch = {
      currImportId: latestWip.id,
      currDayKey: importDayKey(latestWip.reportDate, latestWip.createdAt),
      prevImportId: prevForWatch?.id ?? null,
      prevDayKey: prevForWatch
        ? importDayKey(prevForWatch.reportDate, prevForWatch.createdAt)
        : null,
      current: snapshotOf(latestWip.summary),
      previous: prevForWatch ? snapshotOf(prevForWatch.summary) : null,
    };
  }

  // -------------------------------------------------------------------------
  // Assemble response
  // -------------------------------------------------------------------------
  const allHardRules: DcHardRule[] = [r_dc1, r_dc2, r_dc3, r_dc4, r_dc5, dc6, dc16];
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
    warnings: [r_dc7, r_dc8, r_dc9, r_dc10, r_dc15, r_dc18],
    wipBuckets,
    wipUnclassifiedMarks,
    wipTotalMt,
    wipTotalMarks,
    ntltBuckets,
    ntltUnclassifiedMarks,
    ntltTotalMt,
    ntltTotalMarks,
    dc0StoredTotalRows: dc0Count,
    markMovement,
    dc17,
    sourceColumnWatch,
  };

  res.json(response);
});

export default router;
