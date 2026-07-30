import { Router, type IRouter } from "express";
import { db, importRowsTable, recordPoolTable, importsTable, orderReviewRowsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface ErpSampleRow {
  project: string;
  structure: string;
  markNo: string;
  /** Key→value pairs of the fields that broke the rule. */
  fields: Record<string, string | null>;
}

export interface ErpRuleResult {
  /** e.g. "U1", "T8" */
  id: string;
  /** Plain-English statement of what the rule checks. */
  label: string;
  /** "UNIVERSAL" applies to every row; "TLT" applies to Structure-nature rows only. */
  scope: "UNIVERSAL" | "TLT";
  pass: boolean;
  violatingRowCount: number;
  violatingWeightMt: number;
  /** Up to 10 offending rows. Empty when pass=true. */
  sampleRows: ErpSampleRow[];
}

export interface ErpRulesResponse {
  available: boolean;
  importId?: number;
  asOnDate?: string | null;
  totalRules: number;
  passingRules: number;
  failingRules: number;
  rules: ErpRuleResult[];
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

interface PoolRow {
  project: string | null;
  structure: string;
  markNo: string;
  alias: string | null;
  jobCardType: string | null;
  jobCardStatus: string | null;
  contractor: string | null;
  activity: string | null;
  balanceWt: number;
  copies: number | null;
  lastProductionDate: string | null;
  category: string | null;
  orderNature: string | null;
  isInitialCutting: boolean;
}

function ruleResult(
  id: string,
  label: string,
  scope: "UNIVERSAL" | "TLT",
  violators: Array<{ row: PoolRow; fields: Record<string, string | null> }>,
): ErpRuleResult {
  const pass = violators.length === 0;
  return {
    id,
    label,
    scope,
    pass,
    violatingRowCount: violators.length,
    violatingWeightMt: violators.reduce((s, v) => s + (v.row.balanceWt ?? 0) * (v.row.copies ?? 1), 0) / 1000,
    sampleRows: violators.slice(0, 10).map((v) => ({
      project: v.row.project ?? "",
      structure: v.row.structure,
      markNo: v.row.markNo,
      fields: v.fields,
    })),
  };
}

const TYPE_ALLOWED = new Set([
  "job card not started",
  "job card wip",
  "fg pending for dispatch",
]);
const STATUS_ALLOWED = new Set(["initial", "authorized"]);
const QC_ACTS = new Set(["HG", "RFI", "NH", "B", "HAB", "W", "Q", "TS"]);
const GALV_ACTS = new Set(["G", "GB", "Y"]);
const TLT_WIP_ACTS = new Set([...QC_ACTS, ...GALV_ACTS]);

// ---------------------------------------------------------------------------
// GET /reports/erp-rules
// ---------------------------------------------------------------------------
router.get("/reports/erp-rules", async (_req, res): Promise<void> => {
  // Find the latest WIP import.
  const [latestImport] = await db
    .select({ id: importsTable.id, asOnDate: importsTable.asOnDate })
    .from(importsTable)
    .orderBy(desc(importsTable.id))
    .limit(1);

  if (!latestImport) {
    const empty: ErpRulesResponse = {
      available: false,
      totalRules: 19,
      passingRules: 0,
      failingRules: 0,
      rules: [],
    };
    res.json(empty);
    return;
  }

  // Pull all rows for the latest import.
  const rawRows = await db
    .select({
      project: recordPoolTable.job,
      structure: recordPoolTable.structure,
      markNo: recordPoolTable.markNo,
      alias: recordPoolTable.alias,
      jobCardType: recordPoolTable.jobCardType,
      jobCardStatus: recordPoolTable.jobCardStatus,
      contractor: recordPoolTable.contractor,
      activity: recordPoolTable.activity,
      balanceWt: recordPoolTable.balanceWt,
      copies: importRowsTable.copies,
      lastProductionDate: recordPoolTable.lastProductionDate,
      category: recordPoolTable.category,
      orderNature: recordPoolTable.orderNature,
      isInitialCutting: recordPoolTable.isInitialCutting,
    })
    .from(importRowsTable)
    .innerJoin(recordPoolTable, eq(importRowsTable.poolId, recordPoolTable.id))
    .where(eq(importRowsTable.importId, latestImport.id));

  const rows = rawRows as PoolRow[];

  // -------------------------------------------------------------------------
  // Coverage check: if NO row in this import has job_card_type populated, the
  // file predates Col A (the Type column).  Rules dependent on that column
  // cannot be evaluated — signal this to the client rather than producing
  // false FAILs.
  // -------------------------------------------------------------------------
  const typedRowCount = rows.filter((r) => r.jobCardType !== null).length;
  const hasTypeColumn = typedRowCount > 0;

  if (!hasTypeColumn) {
    // Build all rules as NOT_APPLICABLE
    const naRules: ErpRuleResult[] = [
      ["U1", "Type (Col A) is one of exactly three values: \"Job Card Not Started\", \"Job Card WIP\", \"FG Pending For Dispatch\". Never blank.", "UNIVERSAL"],
      ["U2", "Job Card Status (Col G) is one of exactly two values: \"Initial\", \"Authorized\". Never blank.", "UNIVERSAL"],
      ["U3", "Status \"Initial\" occurs ONLY with Type \"Job Card Not Started\".", "UNIVERSAL"],
      ["U4", "Type \"FG Pending For Dispatch\" always has a BLANK Activity.", "UNIVERSAL"],
      ["U5", "Type \"FG Pending For Dispatch\" is always \"Authorized\".", "UNIVERSAL"],
      ["U6", "Type \"Job Card WIP\" is NEVER activity C.", "UNIVERSAL"],
      ["U7", "Type \"Job Card WIP\" is always \"Authorized\".", "UNIVERSAL"],
      ["U8", "Balance Wt. is greater than zero on every row.", "UNIVERSAL"],
      ["U9", "Mark No. is never blank.", "UNIVERSAL"],
      ["T1", "Type \"Job Card Not Started\" is ALWAYS activity C. (TLT only.)", "TLT"],
      ["T2", "Project Code (Col B) is never blank.", "TLT"],
      ["T3", "Alias (Col J) is never blank.", "TLT"],
      ["T4", "Status \"Initial\" always has a BLANK Contractor.", "TLT"],
      ["T5", "Marks at activity C never have a Last Production Entry Date.", "TLT"],
      ["T6", "Marks at any activity other than C or blank ALWAYS have a Last Production Entry Date.", "TLT"],
      ["T7", "Every \"Job Card WIP\" activity falls in the Quality Check or Galvanising set.", "TLT"],
      ["T8", "The five buckets partition the TLT file exactly.", "TLT"],
      ["X1", "Every structure code that ends with one or more dots (e.g. DN30E., 4QMD3.) must have its own Order Review row distinct from the un-dotted variant.", "TLT"],
      ["X2", "Every TLT WIP structure that carries pool balance must have a corresponding Order Review row.", "TLT"],
    ].map(([id, label, scope]) => ({
      id: id as string,
      label: label as string,
      scope: scope as "UNIVERSAL" | "TLT",
      pass: true,          // neutral — not a failure
      notApplicable: true, // frontend uses this to show N/A badge instead of PASS
      violatingRowCount: 0,
      violatingWeightMt: 0,
      sampleRows: [],
    }));

    const naResponse: ErpRulesResponse & { typeColumnMissing: boolean } = {
      available: true,
      importId: latestImport.id,
      asOnDate: latestImport.asOnDate,
      typeColumnMissing: true,
      totalRules: naRules.length,
      passingRules: 0,
      failingRules: 0,
      rules: naRules,
    };
    res.json(naResponse);
    return;
  }

  // TLT-scoped rows: Order Nature = "Structure" (case-insensitive) or category = "TLT".
  const tlt = rows.filter(
    (r) =>
      r.category === "TLT" ||
      (r.orderNature ?? "").trim().toUpperCase() === "STRUCTURE",
  );

  // Helper: normalize text fields for comparison.
  const jct = (r: PoolRow) => (r.jobCardType ?? "").trim().toLowerCase();
  const jcs = (r: PoolRow) => (r.jobCardStatus ?? "").trim().toLowerCase();
  const act = (r: PoolRow) => (r.activity ?? "").trim().toUpperCase();

  // ---------------------------------------------------------------------------
  // SECTION 1 — UNIVERSAL
  // ---------------------------------------------------------------------------

  // U1: Type in 3 allowed values, never blank.
  const u1 = rows.filter((r) => {
    const t = jct(r);
    return !t || !TYPE_ALLOWED.has(t);
  });
  const r_u1 = ruleResult(
    "U1",
    'Type (Col A) is one of exactly three values: "Job Card Not Started", "Job Card WIP", "FG Pending For Dispatch". Never blank.',
    "UNIVERSAL",
    u1.map((r) => ({ row: r, fields: { "Job Card Type": r.jobCardType } })),
  );

  // U2: Status in 2 allowed values, never blank.
  const u2 = rows.filter((r) => {
    const s = jcs(r);
    return !s || !STATUS_ALLOWED.has(s);
  });
  const r_u2 = ruleResult(
    "U2",
    'Job Card Status (Col G) is one of exactly two values: "Initial", "Authorized". Never blank.',
    "UNIVERSAL",
    u2.map((r) => ({ row: r, fields: { "Job Card Status": r.jobCardStatus } })),
  );

  // U3: Status "Initial" only with Type "Job Card Not Started".
  const u3 = rows.filter(
    (r) =>
      jcs(r) === "initial" &&
      jct(r) !== "job card not started",
  );
  const r_u3 = ruleResult(
    "U3",
    'Status "Initial" occurs ONLY with Type "Job Card Not Started".',
    "UNIVERSAL",
    u3.map((r) => ({
      row: r,
      fields: { "Job Card Type": r.jobCardType, "Job Card Status": r.jobCardStatus },
    })),
  );

  // U4: Type "FG Pending For Dispatch" always has blank Activity.
  const u4 = rows.filter(
    (r) => jct(r) === "fg pending for dispatch" && act(r) !== "",
  );
  const r_u4 = ruleResult(
    "U4",
    'Type "FG Pending For Dispatch" always has a BLANK Activity.',
    "UNIVERSAL",
    u4.map((r) => ({
      row: r,
      fields: { "Job Card Type": r.jobCardType, Activity: r.activity },
    })),
  );

  // U5: Type "FG Pending For Dispatch" always "Authorized".
  const u5 = rows.filter(
    (r) =>
      jct(r) === "fg pending for dispatch" && jcs(r) !== "authorized",
  );
  const r_u5 = ruleResult(
    "U5",
    'Type "FG Pending For Dispatch" is always "Authorized".',
    "UNIVERSAL",
    u5.map((r) => ({
      row: r,
      fields: { "Job Card Type": r.jobCardType, "Job Card Status": r.jobCardStatus },
    })),
  );

  // U6: Type "Job Card WIP" NEVER activity C.
  const u6 = rows.filter(
    (r) => jct(r) === "job card wip" && act(r) === "C",
  );
  const r_u6 = ruleResult(
    "U6",
    'Type "Job Card WIP" is NEVER activity C.',
    "UNIVERSAL",
    u6.map((r) => ({
      row: r,
      fields: { "Job Card Type": r.jobCardType, Activity: r.activity },
    })),
  );

  // U7: Type "Job Card WIP" always "Authorized".
  const u7 = rows.filter(
    (r) => jct(r) === "job card wip" && jcs(r) !== "authorized",
  );
  const r_u7 = ruleResult(
    "U7",
    'Type "Job Card WIP" is always "Authorized".',
    "UNIVERSAL",
    u7.map((r) => ({
      row: r,
      fields: { "Job Card Type": r.jobCardType, "Job Card Status": r.jobCardStatus },
    })),
  );

  // U8: Balance Wt. > 0 on every row.
  const u8 = rows.filter((r) => !(r.balanceWt > 0));
  const r_u8 = ruleResult(
    "U8",
    "Balance Wt. is greater than zero on every row.",
    "UNIVERSAL",
    u8.map((r) => ({
      row: r,
      fields: { "Balance Wt.": String(r.balanceWt) },
    })),
  );

  // U9: Mark No. never blank.
  const u9 = rows.filter((r) => !r.markNo || r.markNo.trim() === "");
  const r_u9 = ruleResult(
    "U9",
    "Mark No. is never blank.",
    "UNIVERSAL",
    u9.map((r) => ({ row: r, fields: { "Mark No.": r.markNo } })),
  );

  // ---------------------------------------------------------------------------
  // SECTION 2 — TLT ONLY
  // ---------------------------------------------------------------------------

  // T1: Type "Job Card Not Started" ALWAYS activity C (TLT only).
  const t1 = tlt.filter(
    (r) => jct(r) === "job card not started" && act(r) !== "C",
  );
  const r_t1 = ruleResult(
    "T1",
    'Type "Job Card Not Started" is ALWAYS activity C. (TLT only — NTLT not-started work uses BL/NTF/NTFSW/G/TS.)',
    "TLT",
    t1.map((r) => ({
      row: r,
      fields: { "Job Card Type": r.jobCardType, Activity: r.activity },
    })),
  );

  // T2: Project Code never blank (TLT).
  const t2 = tlt.filter((r) => !r.project || r.project.trim() === "" || r.project === "(Unassigned)");
  const r_t2 = ruleResult(
    "T2",
    "Project Code (Col B) is never blank.",
    "TLT",
    t2.map((r) => ({ row: r, fields: { "Project Code": r.project } })),
  );

  // T3: Alias never blank (TLT).
  const t3 = tlt.filter((r) => !r.alias || r.alias.trim() === "");
  const r_t3 = ruleResult(
    "T3",
    "Alias (Col J) is never blank.",
    "TLT",
    t3.map((r) => ({ row: r, fields: { Alias: r.alias } })),
  );

  // T4: Status "Initial" always blank contractor (TLT).
  const t4 = tlt.filter(
    (r) =>
      jcs(r) === "initial" &&
      r.contractor != null &&
      r.contractor.trim() !== "",
  );
  const r_t4 = ruleResult(
    "T4",
    'Status "Initial" always has a BLANK Contractor.',
    "TLT",
    t4.map((r) => ({
      row: r,
      fields: { "Job Card Status": r.jobCardStatus, Contractor: r.contractor },
    })),
  );

  // T5: Marks at activity C never have Last Production Entry Date (TLT).
  const t5 = tlt.filter(
    (r) =>
      act(r) === "C" &&
      r.lastProductionDate != null &&
      r.lastProductionDate.trim() !== "",
  );
  const r_t5 = ruleResult(
    "T5",
    "Marks at activity C never have a Last Production Entry Date.",
    "TLT",
    t5.map((r) => ({
      row: r,
      fields: { Activity: r.activity, "Last Production Date": r.lastProductionDate },
    })),
  );

  // T6: Marks at any activity other than C or blank ALWAYS have Last Production Entry Date (TLT).
  const t6 = tlt.filter(
    (r) => {
      const a = act(r);
      if (!a || a === "C") return false; // blank and C are excluded from the requirement
      return !r.lastProductionDate || r.lastProductionDate.trim() === "";
    },
  );
  const r_t6 = ruleResult(
    "T6",
    "Marks at any activity other than C or blank ALWAYS have a Last Production Entry Date.",
    "TLT",
    t6.map((r) => ({
      row: r,
      fields: { Activity: r.activity, "Last Production Date": r.lastProductionDate },
    })),
  );

  // T7: Every "Job Card WIP" activity falls in QC or Galvanising set (TLT).
  const t7 = tlt.filter(
    (r) => jct(r) === "job card wip" && !TLT_WIP_ACTS.has(act(r)),
  );
  const r_t7 = ruleResult(
    "T7",
    "Every \"Job Card WIP\" activity falls in the Quality Check set {HG,RFI,NH,B,HAB,W,Q,TS} or Galvanising set {G,GB,Y}.",
    "TLT",
    t7.map((r) => ({
      row: r,
      fields: { "Job Card Type": r.jobCardType, Activity: r.activity },
    })),
  );

  // T8: Five buckets partition TLT exactly (zero unclassified).
  // Buckets: Release (JCNS+Initial), Cutting (JCNS+Authorized), QC (WIP+QC-act), Galv (WIP+Galv-act), FG (FG+blank).
  const t8 = tlt.filter((r) => {
    const tp = jct(r);
    const st = jcs(r);
    const a = act(r);
    if (tp === "job card not started" && st === "initial") return false; // Release
    if (tp === "job card not started" && st === "authorized") return false; // Cutting
    if (tp === "job card wip" && QC_ACTS.has(a)) return false;            // QC
    if (tp === "job card wip" && GALV_ACTS.has(a)) return false;          // Galv
    if (tp === "fg pending for dispatch" && a === "") return false;        // FG
    return true; // unclassified
  });
  const r_t8 = ruleResult(
    "T8",
    "The five buckets partition the TLT file exactly: Release + Cutting + Quality Check + Galvanising + FG WIP = total TLT balance, with zero unclassified marks.",
    "TLT",
    t8.map((r) => ({
      row: r,
      fields: {
        "Job Card Type": r.jobCardType,
        "Job Card Status": r.jobCardStatus,
        Activity: r.activity,
      },
    })),
  );

  // -------------------------------------------------------------------------
  // X1: Every dotted structure code must have its own Order Review row.
  //
  // Trailing dots encode distinct physical tower types (e.g. DN30E = +3 m
  // extension, DN30E. = +6 m, DN30E.. = +9 m).  If both a bare form and a
  // dotted form appear in WIP, each MUST have its own OR entry.  This rule
  // catches a future parser change that collapses trailing dots, because the
  // join rate would immediately drop below 100% and this rule would fail.
  // -------------------------------------------------------------------------
  const orPairs = await db
    .select({ project: orderReviewRowsTable.project, structure: orderReviewRowsTable.structure })
    .from(orderReviewRowsTable);
  const orSet = new Set(orPairs.map((o) => `${o.project}\x00${o.structure}`));

  // Dotted structures in WIP with no OR counterpart.
  const dottedWithoutOr = tlt.filter(
    (r) =>
      r.structure.endsWith(".") &&
      !orSet.has(`${r.project ?? ""}\x00${r.structure}`),
  );

  const r_x1 = ruleResult(
    "X1",
    "Every structure code that ends with one or more dots (e.g. DN30E., 4QMD3.) must have its own Order Review row distinct from the un-dotted variant. " +
    "Trailing dots encode extension height; they are NOT typos. " +
    "This rule fails if a parser collapses trailing dots, causing silent weight mis-attribution.",
    "TLT",
    dottedWithoutOr.map((r) => ({
      row: r,
      fields: { Structure: r.structure, Project: r.project },
    })),
  );

  // -------------------------------------------------------------------------
  // X2: Every TLT WIP structure with pool balance must have an Order Review row.
  //
  // Structures that appear in the WIP file but have no matching OR entry cannot
  // be attributed to a confirmed contract quantity and are invisible to all
  // order-vs-fabrication comparisons (Fab Completion, Generated OR chain, etc.).
  // One representative pool row is shown per (project, structure) pair to
  // avoid flooding the sample list with individual mark rows.
  // Dotted structures caught by X1 are included here too — if X1 also fails
  // the same structure appears in both rules, which is intentional.
  // -------------------------------------------------------------------------
  const unmatchedByStructure = new Map<string, PoolRow>();
  for (const r of tlt) {
    const key = `${r.project ?? ""}\x00${r.structure}`;
    if (!orSet.has(key) && !unmatchedByStructure.has(key)) {
      unmatchedByStructure.set(key, r);
    }
  }

  const r_x2 = ruleResult(
    "X2",
    "Every TLT WIP structure that carries pool balance must have a corresponding Order Review row. " +
    "Structures with no OR row cannot be attributed to a confirmed contract quantity and will not appear " +
    "in order-vs-fabrication comparisons (Fab Completion, Generated OR chain, Consistency Panel). " +
    "Fix by adding the missing row(s) to the Order Review file before the next upload.",
    "TLT",
    [...unmatchedByStructure.values()].map((r) => ({
      row: r,
      fields: { Structure: r.structure, Project: r.project },
    })),
  );

  const allRules: ErpRuleResult[] = [
    r_u1, r_u2, r_u3, r_u4, r_u5, r_u6, r_u7, r_u8, r_u9,
    r_t1, r_t2, r_t3, r_t4, r_t5, r_t6, r_t7, r_t8,
    r_x1, r_x2,
  ];

  const totalRules = allRules.length;
  const failingRules = allRules.filter((r) => !r.pass).length;

  const response: ErpRulesResponse = {
    available: true,
    importId: latestImport.id,
    asOnDate: latestImport.asOnDate,
    totalRules,
    passingRules: totalRules - failingRules,
    failingRules,
    rules: allRules,
  };

  res.json(response);
});

export default router;
