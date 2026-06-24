import { Router, type IRouter } from "express";
import { eq, lt, desc } from "drizzle-orm";
import { requireAuth } from "./auth";
import {
  db,
  importsTable,
  recordPoolTable,
  importRowsTable,
  type RecordPoolRow,
} from "@workspace/db";
import { AiSanitizeBody, AiReviewBody, AiReportBody, AiReportResponse } from "@workspace/api-zod";
import { sortActivities, isKnownActivity } from "@workspace/domain";
import { buildChangeSet, type MembershipRow, type ChangeSet } from "../lib/diff";
import {
  computeAgeing,
  computeRoute,
  isTruncatingCleanup,
  isCuttingActivity,
  isFutureDate,
} from "../lib/parse";
import { buildAnalyticsPack } from "../lib/report";
import {
  AI_MODEL_STANDARD,
  AI_MODEL_DEEP,
  isAiAvailable,
  callClaude,
  parseJsonObject,
} from "../lib/ai";

const router: IRouter = Router();

router.get("/ai/status", async (_req, res): Promise<void> => {
  res.json({ available: isAiAvailable() });
});

// Descriptive fields the model may suggest cleanups for. Deliberately EXCLUDES
// anything that changes row identity (job/structure/markTail/markNo/alias,
// jobCardNo) or any computed/engine field (balanceQty/balanceWt/activity/
// operation), so a suggestion can never alter how the deterministic engine
// merges or what it reports.
const SANITIZE_FIELDS = [
  "contractor",
  "section",
  "assignDate",
  "lastProductionDate",
  "towerType",
  "towerSubType",
  "orderNature",
  "refJobCardNo",
] as const;
type SanitizeField = (typeof SANITIZE_FIELDS)[number];

const MAX_SANITIZE_ROWS = 400;

async function loadPoolRows(importId: number): Promise<RecordPoolRow[]> {
  const rows = await db
    .select({ pool: recordPoolTable })
    .from(importRowsTable)
    .innerJoin(recordPoolTable, eq(importRowsTable.poolId, recordPoolTable.id))
    .where(eq(importRowsTable.importId, importId));
  return rows.map((r) => r.pool);
}

async function loadMembershipLite(importId: number): Promise<MembershipRow[]> {
  const rows = await db
    .select({ pool: recordPoolTable, copies: importRowsTable.copies })
    .from(importRowsTable)
    .innerJoin(recordPoolTable, eq(importRowsTable.poolId, recordPoolTable.id))
    .where(eq(importRowsTable.importId, importId));
  return rows.map(({ pool, copies }) => ({
    row: {
      hash: pool.hash,
      job: pool.job,
      structure: pool.structure,
      markTail: pool.markTail,
      markId: pool.markId,
      jobCardNo: pool.jobCardNo,
      contractor: pool.contractor,
      section: pool.section,
      assignDate: pool.assignDate,
      lastProductionDate: pool.lastProductionDate,
      activity: pool.activity,
      operation: pool.operation,
      balanceQty: pool.balanceQty,
      balanceWt: pool.balanceWt,
    },
    copies,
  }));
}

router.post("/ai/sanitize", requireAuth, async (req, res): Promise<void> => {
  const parsed = AiSanitizeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { importId } = parsed.data;

  // Availability is independent of the data: report the disabled state before
  // touching the DB so the app works fully (and verifiably) with no key.
  if (!isAiAvailable()) {
    res.json({ available: false, suggestions: [], counts: { dates: 0, names: 0, other: 0 } });
    return;
  }

  const [imp] = await db
    .select({ id: importsTable.id })
    .from(importsTable)
    .where(eq(importsTable.id, importId));
  if (!imp) {
    res.status(404).json({ error: "Import not found" });
    return;
  }

  const pool = await loadPoolRows(importId);
  // Distinct by hash, then cap for a bounded prompt.
  const byHash = new Map<string, RecordPoolRow>();
  for (const r of pool) if (!byHash.has(r.hash)) byHash.set(r.hash, r);
  const distinct = Array.from(byHash.values()).slice(0, MAX_SANITIZE_ROWS);

  const compact = distinct.map((r) => {
    const o: Record<string, string | null> = { poolHash: r.hash };
    for (const f of SANITIZE_FIELDS) o[f] = r[f as keyof RecordPoolRow] as string | null;
    return o;
  });

  const system =
    "You clean descriptive metadata in a steel-fabrication tracking export. " +
    "You ONLY suggest cleanups; you never apply them and you never invent data. " +
    "Allowed fields: " +
    SANITIZE_FIELDS.join(", ") +
    ". NEVER suggest changes to any other field, to quantities, weights, activity, " +
    "operation, or mark identity. For name fields (contractor, section, and any " +
    "other non-date field) ONLY fix whitespace, punctuation spacing, and casing. " +
    "NEVER remove or shorten any suffix, unit designation, branch code, " +
    "parenthetical, or hyphenated tag (e.g. GP-2, UNIT-II, (JW), - JW, BDM). Names " +
    "that differ only by such a tag are DIFFERENT contractors and must stay " +
    "separate — never merge them. If the only difference between two names is real " +
    "text tokens, make no suggestion. For the date fields (assignDate, " +
    "lastProductionDate) ONLY normalize the format to YYYY-MM-DD: NEVER invent a " +
    "missing date, NEVER shift a real date, and NEVER change a future date (blank " +
    "stays blank). Activity codes are NEVER changed (BL/NTF/NTFSW and any other code " +
    "stay exactly as-is). Do not suggest a change when the value " +
    "is already clean. Respond with STRICT JSON only, no prose, no code fences, " +
    'shaped exactly as: {"suggestions":[{"poolHash":string,"field":string,' +
    '"from":string|null,"to":string|null,"reason":string}],' +
    '"counts":{"dates":number,"names":number,"other":number}}.';

  const user =
    "Rows (one per distinct record, keyed by poolHash):\n" +
    JSON.stringify(compact);

  const result = await callClaude({ model: AI_MODEL_STANDARD, system, user });
  if (!result.ok) {
    req.log.warn({ importId }, "AI sanitize call failed");
    res.json({ available: false, suggestions: [], counts: { dates: 0, names: 0, other: 0 } });
    return;
  }

  const obj = parseJsonObject(result.text);
  const validHashes = new Set(distinct.map((r) => r.hash));
  const allowed = new Set<string>(SANITIZE_FIELDS);
  const suggestions: {
    poolHash: string;
    field: string;
    from: string | null;
    to: string | null;
    reason: string;
  }[] = [];

  if (obj && typeof obj === "object" && Array.isArray((obj as { suggestions?: unknown }).suggestions)) {
    for (const s of (obj as { suggestions: unknown[] }).suggestions) {
      if (!s || typeof s !== "object") continue;
      const poolHash = (s as { poolHash?: unknown }).poolHash;
      const field = (s as { field?: unknown }).field;
      const to = (s as { to?: unknown }).to;
      // Hard server-side guardrails: drop anything outside the allow-list or
      // referencing a row we did not send.
      if (typeof poolHash !== "string" || !validHashes.has(poolHash)) continue;
      if (typeof field !== "string" || !allowed.has(field)) continue;
      const original = byHash.get(poolHash);
      const fromVal = original
        ? ((original[field as keyof RecordPoolRow] as string | null) ?? null)
        : null;
      const toVal = typeof to === "string" ? to : to === null ? null : null;
      if (toVal === fromVal) continue;
      // Block truncating/merging name changes (e.g. dropping a "GP-2"/"(UNIT-II)"
      // suffix) server-side so two distinct entities are never collapsed into one.
      if (isTruncatingCleanup(field, fromVal, toVal)) {
        req.log.warn(
          { importId, field, from: fromVal, to: toVal },
          "Dropped truncating sanitize suggestion (token set changed)",
        );
        continue;
      }
      const reason = (s as { reason?: unknown }).reason;
      suggestions.push({
        poolHash,
        field,
        from: fromVal,
        to: toVal,
        reason: typeof reason === "string" ? reason : "Suggested cleanup",
      });
    }
  }

  const counts = { dates: 0, names: 0, other: 0 };
  for (const s of suggestions) {
    if (s.field === "assignDate" || s.field === "lastProductionDate") counts.dates++;
    else if (s.field === "contractor" || s.field === "section") counts.names++;
    else counts.other++;
  }

  res.json({ available: true, suggestions, counts });
});

interface ReviewSignals {
  rowsKept: number;
  distinctRows: number;
  nullContractor: number;
  nullDate: number;
  // Last Production Entry Date (col S) data-quality signals.
  notStarted: number; // blank production date AND activity == C
  noProductionDate: number; // blank production date AND activity != C (progressed but date missing)
  noProductionDateByActivity: { activity: string; count: number }[];
  futureProductionDate: number; // production date > today (clamped to today for ageing)
  ageing: { min: number | null; max: number | null; avg: number | null; counted: number };
  activityCodes: string[];
  unknownActivityCodes: string[];
  activityNotInRoute: { markId: string; activity: string; operation: string }[];
  changeCounts: ChangeSet["counts"];
  netPendingQtyChange: number;
  netPendingWtChange: number;
  engineFlags: string[];
}

function computeSignals(membership: MembershipRow[], changeSet: ChangeSet): ReviewSignals {
  let nullContractor = 0;
  let nullDate = 0;
  let agSum = 0;
  let agCount = 0;
  let agMin: number | null = null;
  let agMax: number | null = null;
  const activityCodes = new Set<string>();
  const notInRoute: { markId: string; activity: string; operation: string }[] = [];
  const distinctHashes = new Set<string>();
  let notStarted = 0;
  let noProductionDate = 0;
  let futureProductionDate = 0;
  const noProdByActivity = new Map<string, number>();

  for (const { row, copies } of membership) {
    // Production-date and ageing counts mirror the parse summary, which counts
    // every kept (expanded) row — so weight them by `copies` (in-file duplicates).
    distinctHashes.add(row.hash);
    if (row.contractor == null) nullContractor++;
    if (row.assignDate == null) nullDate++;
    if (row.lastProductionDate == null) {
      if (isCuttingActivity(row.activity)) {
        notStarted += copies;
      } else {
        noProductionDate += copies;
        const key = row.activity ?? "(none)";
        noProdByActivity.set(key, (noProdByActivity.get(key) ?? 0) + copies);
      }
    } else if (isFutureDate(row.lastProductionDate)) {
      futureProductionDate += copies;
    }
    const ag = computeAgeing(row.lastProductionDate);
    if (ag !== null) {
      agSum += ag * copies;
      agCount += copies;
      agMin = agMin === null ? ag : Math.min(agMin, ag);
      agMax = agMax === null ? ag : Math.max(agMax, ag);
    }
    if (row.activity) {
      activityCodes.add(row.activity);
      const { routeSteps, currentStepIndex } = computeRoute(row.operation, row.activity);
      if (routeSteps.length > 0 && currentStepIndex === null && notInRoute.length < 25) {
        notInRoute.push({
          markId: row.markId,
          activity: row.activity,
          operation: row.operation ?? "",
        });
      }
    }
  }

  let rowsKept = 0;
  for (const m of membership) rowsKept += m.copies;

  return {
    rowsKept,
    distinctRows: distinctHashes.size,
    nullContractor,
    nullDate,
    notStarted,
    noProductionDate,
    noProductionDateByActivity: sortActivities(
      Array.from(noProdByActivity.keys()),
    ).map((activity) => ({ activity, count: noProdByActivity.get(activity) ?? 0 })),
    futureProductionDate,
    ageing: {
      min: agMin,
      max: agMax,
      avg: agCount > 0 ? Math.round(agSum / agCount) : null,
      counted: agCount,
    },
    activityCodes: sortActivities(Array.from(activityCodes)),
    unknownActivityCodes: sortActivities(
      Array.from(activityCodes).filter((c) => !isKnownActivity(c)),
    ),
    activityNotInRoute: notInRoute,
    changeCounts: changeSet.counts,
    netPendingQtyChange: changeSet.netPendingQtyChange,
    netPendingWtChange: changeSet.netPendingWtChange,
    engineFlags: changeSet.flags,
  };
}

type FindingSeverity = "info" | "warn" | "error";
interface ReviewFinding {
  severity: FindingSeverity;
  check: string;
  markId: string | null;
  message: string;
  expected: string | null;
  actual: string | null;
}

function coerceReview(
  obj: unknown,
  deep: boolean,
): {
  verdict: "pass" | "warn" | "fail" | null;
  summary: string | null;
  stats: Record<string, unknown> | null;
  findings: ReviewFinding[];
  plan: string[] | null;
} {
  const o = obj && typeof obj === "object" ? (obj as Record<string, unknown>) : {};
  const verdictRaw = o.verdict;
  const verdict =
    verdictRaw === "pass" || verdictRaw === "warn" || verdictRaw === "fail"
      ? verdictRaw
      : null;
  const summary = typeof o.summary === "string" ? o.summary : null;
  const stats =
    o.stats && typeof o.stats === "object" && !Array.isArray(o.stats)
      ? (o.stats as Record<string, unknown>)
      : null;
  const findings: ReviewFinding[] = [];
  if (Array.isArray(o.findings)) {
    for (const f of o.findings) {
      if (!f || typeof f !== "object") continue;
      const ff = f as Record<string, unknown>;
      const sev = ff.severity;
      const severity: FindingSeverity =
        sev === "error" ? "error" : sev === "warn" ? "warn" : "info";
      findings.push({
        severity,
        check: typeof ff.check === "string" ? ff.check : "check",
        markId: typeof ff.markId === "string" ? ff.markId : null,
        message: typeof ff.message === "string" ? ff.message : "",
        expected: typeof ff.expected === "string" ? ff.expected : null,
        actual: typeof ff.actual === "string" ? ff.actual : null,
      });
    }
  }
  let plan: string[] | null = null;
  if (deep && Array.isArray(o.plan)) {
    plan = o.plan.filter((p): p is string => typeof p === "string");
  }
  return { verdict, summary, stats, findings, plan };
}

const REVIEW_SCHEMA_HINT =
  'Respond with STRICT JSON only, no prose, no code fences, shaped exactly as: ' +
  '{"verdict":"pass"|"warn"|"fail","summary":string,"stats":{...key/value...},' +
  '"findings":[{"severity":"info"|"warn"|"error","check":string,' +
  '"markId":string|null,"message":string,"expected":string|null,' +
  '"actual":string|null}]';

router.post("/ai/review", requireAuth, async (req, res): Promise<void> => {
  const parsed = AiReviewBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { importId, compareTo, deep } = parsed.data;

  // Availability is independent of the data: report the disabled state before
  // touching the DB so the app works fully (and verifiably) with no key.
  if (!isAiAvailable()) {
    res.json({
      available: false,
      verdict: null,
      summary: null,
      stats: null,
      findings: [],
      plan: null,
      deep: false,
    });
    return;
  }

  const [toImport] = await db
    .select()
    .from(importsTable)
    .where(eq(importsTable.id, importId));
  if (!toImport) {
    res.status(404).json({ error: "Import not found" });
    return;
  }

  // Resolve the base import: explicit compareTo, else the previous import.
  let fromImport: typeof toImport | undefined;
  if (compareTo != null) {
    const [base] = await db
      .select()
      .from(importsTable)
      .where(eq(importsTable.id, compareTo));
    if (!base) {
      res.status(404).json({ error: "Comparison import not found" });
      return;
    }
    fromImport = base;
  } else {
    const [prev] = await db
      .select()
      .from(importsTable)
      .where(lt(importsTable.id, toImport.id))
      .orderBy(desc(importsTable.id))
      .limit(1);
    fromImport = prev;
  }

  const nextMembership = await loadMembershipLite(toImport.id);
  const prevMembership = fromImport ? await loadMembershipLite(fromImport.id) : [];
  const changeSet = buildChangeSet(
    prevMembership,
    nextMembership,
    fromImport ? { id: fromImport.id, label: fromImport.label } : null,
    { id: toImport.id, label: toImport.label },
  );

  const signals = computeSignals(nextMembership, changeSet);

  const system =
    "You are a meticulous QA reviewer for a steel-fabrication balance/activity " +
    "report. A deterministic engine has ALREADY computed the results; you confirm " +
    "consistency and surface anomalies, you do NOT recompute results or change any " +
    "value. Ageing = today - Last Production Entry Date (blank date is excluded from " +
    "averages; future dates are clamped to today). Audit: ageing math sanity, the " +
    "'No production date' backlog (marks past Cutting with no production date — a " +
    "data-quality issue) via noProductionDate/noProductionDateByActivity, the " +
    "futureProductionDate count, unknown/odd activity codes (e.g. BL/NTF/NTFSW; valid " +
    "data, never rename), activity not in " +
    "its operation route, null contractor or date, backward route moves, balance " +
    "quantity increases, mass contractor reassignment, and a flood of completed " +
    "marks (which can indicate a partial file). Be precise and conservative: a clean " +
    "import is a pass. " +
    REVIEW_SCHEMA_HINT +
    (deep
      ? ',"plan":[string,...]} where plan is a prioritized, root-cause-ordered list of remediation steps.'
      : "}.");

  const user =
    "Parse summary:\n" +
    JSON.stringify(toImport.summary) +
    "\n\nDeterministic signals (already computed; confirm, do not recompute):\n" +
    JSON.stringify(signals) +
    "\n\nChange set sample (capped):\n" +
    JSON.stringify({
      counts: changeSet.counts,
      flags: changeSet.flags,
      netPendingQtyChange: changeSet.netPendingQtyChange,
      netPendingWtChange: changeSet.netPendingWtChange,
      movedActivity: changeSet.movedActivity.slice(0, 20),
      qtyChanged: changeSet.qtyChanged.slice(0, 20),
      newMarks: changeSet.newMarks.slice(0, 20),
      completed: changeSet.completed.slice(0, 20),
    });

  // Standard pass.
  const standard = await callClaude({ model: AI_MODEL_STANDARD, system, user });
  if (!standard.ok) {
    req.log.warn({ importId }, "AI review call failed");
    res.json({
      available: false,
      verdict: null,
      summary: null,
      stats: null,
      findings: [],
      plan: null,
      deep: false,
    });
    return;
  }

  const standardReview = coerceReview(parseJsonObject(standard.text), false);
  const wantsDeep = deep === true || standardReview.verdict !== "pass";

  if (!wantsDeep) {
    res.json({ available: true, deep: false, ...standardReview });
    return;
  }

  // Deep pass with the stronger model; adds a prioritized remediation plan.
  const deepSystem =
    system +
    " Provide the deepest analysis: include a 'plan' array of prioritized, " +
    "root-cause-first remediation steps.";
  const deepUser =
    user +
    "\n\nStandard review (for context; refine and add a remediation plan):\n" +
    JSON.stringify(standardReview);

  const deepRes = await callClaude({ model: AI_MODEL_DEEP, system: deepSystem, user: deepUser });
  if (!deepRes.ok) {
    // Fall back to the standard result rather than failing the request.
    res.json({ available: true, deep: false, ...standardReview });
    return;
  }
  const deepReview = coerceReview(parseJsonObject(deepRes.text), true);
  res.json({ available: true, deep: true, ...deepReview });
});

// ---------------------------------------------------------------------------
// AI turnaround report (deep, advisory, read-only)
// ---------------------------------------------------------------------------

type Health = "good" | "watch" | "critical";
type RiskSeverity = "high" | "med" | "low";
type Effort = "low" | "med" | "high";
type Horizon = "now" | "week" | "month";
type BottleneckArea = "activity" | "contractor" | "job" | "structure";

interface ReportSummary {
  headline: string;
  health: Health;
  topRisks: { title: string; severity: RiskSeverity; metric: string; why: string }[];
}
interface ReportAction {
  priority: number;
  action: string;
  target: string;
  rationale: string;
  expectedImpact: string;
  effort: Effort;
  horizon: Horizon;
}
interface ReportDetailed {
  bottlenecks: { area: BottleneckArea; name: string; metric: string; finding: string }[];
  ageingAnalysis: string;
  contractorAnalysis: string;
  throughput: string;
  dataQuality: string[];
  assumptions: string[];
}
interface ReportBody {
  summary: ReportSummary | null;
  actionPlan: ReportAction[];
  detailed: ReportDetailed | null;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function coerceReport(obj: unknown): ReportBody {
  const o = obj && typeof obj === "object" ? (obj as Record<string, unknown>) : {};

  let summary: ReportSummary | null = null;
  if (o.summary && typeof o.summary === "object") {
    const s = o.summary as Record<string, unknown>;
    const risks = Array.isArray(s.topRisks) ? s.topRisks : [];
    summary = {
      headline: str(s.headline),
      health: oneOf<Health>(s.health, ["good", "watch", "critical"], "watch"),
      topRisks: risks
        .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
        .slice(0, 6)
        .map((r) => ({
          title: str(r.title),
          severity: oneOf<RiskSeverity>(r.severity, ["high", "med", "low"], "med"),
          metric: str(r.metric),
          why: str(r.why),
        })),
    };
  }

  const actionsRaw = Array.isArray(o.actionPlan) ? o.actionPlan : [];
  const actionPlan: ReportAction[] = actionsRaw
    .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
    .map((a, i) => ({
      priority: typeof a.priority === "number" ? a.priority : i + 1,
      action: str(a.action),
      target: str(a.target),
      rationale: str(a.rationale),
      expectedImpact: str(a.expectedImpact),
      effort: oneOf<Effort>(a.effort, ["low", "med", "high"], "med"),
      horizon: oneOf<Horizon>(a.horizon, ["now", "week", "month"], "week"),
    }))
    .sort((x, y) => x.priority - y.priority);

  let detailed: ReportDetailed | null = null;
  if (o.detailed && typeof o.detailed === "object") {
    const d = o.detailed as Record<string, unknown>;
    const bn = Array.isArray(d.bottlenecks) ? d.bottlenecks : [];
    detailed = {
      bottlenecks: bn
        .filter((b): b is Record<string, unknown> => !!b && typeof b === "object")
        .map((b) => ({
          area: oneOf<BottleneckArea>(
            b.area,
            ["activity", "contractor", "job", "structure"],
            "activity",
          ),
          name: str(b.name),
          metric: str(b.metric),
          finding: str(b.finding),
        })),
      ageingAnalysis: str(d.ageingAnalysis),
      contractorAnalysis: str(d.contractorAnalysis),
      throughput: str(d.throughput),
      dataQuality: strArray(d.dataQuality),
      assumptions: strArray(d.assumptions),
    };
  }

  return { summary, actionPlan, detailed };
}

function unavailableReport(): Record<string, unknown> {
  return {
    available: false,
    generatedAt: null,
    importId: null,
    model: null,
    filtered: false,
    cached: false,
    summary: null,
    actionPlan: [],
    detailed: null,
  };
}

function filtersActive(f: {
  job?: string | null;
  structure?: string | null;
  mark?: string | null;
  contractor?: string | null;
  activity?: string | null;
  search?: string | null;
  dateStart?: string | null;
  dateEnd?: string | null;
}): boolean {
  return Boolean(
    f.job ||
      f.structure ||
      f.mark ||
      f.contractor ||
      f.activity ||
      (f.search && f.search.trim()) ||
      f.dateStart ||
      f.dateEnd,
  );
}

function applyFilters(
  membership: MembershipRow[],
  f: {
    job?: string | null;
    structure?: string | null;
    mark?: string | null;
    contractor?: string | null;
    activity?: string | null;
    search?: string | null;
    dateStart?: string | null;
    dateEnd?: string | null;
  },
): MembershipRow[] {
  const q = f.search?.trim().toLowerCase() ?? "";
  return membership.filter(({ row }) => {
    if (f.job && row.job !== f.job) return false;
    if (f.structure && row.structure !== f.structure) return false;
    if (f.mark && row.markId !== f.mark && row.markTail !== f.mark) return false;
    if (f.contractor && row.contractor !== f.contractor) return false;
    if (f.activity && row.activity !== f.activity) return false;
    if (f.dateStart || f.dateEnd) {
      const d = row.assignDate;
      if (!d) return false;
      if (f.dateStart && d < f.dateStart) return false;
      if (f.dateEnd && d >= f.dateEnd) return false;
    }
    if (q) {
      const hit =
        row.markId?.toLowerCase().includes(q) ||
        row.markTail?.toLowerCase().includes(q) ||
        row.section?.toLowerCase().includes(q) ||
        row.contractor?.toLowerCase().includes(q);
      if (!hit) return false;
    }
    return true;
  });
}

router.post("/ai/report", requireAuth, async (req, res): Promise<void> => {
  const parsed = AiReportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { importId, compareTo, regenerate, filters } = parsed.data;

  if (!isAiAvailable()) {
    res.json(unavailableReport());
    return;
  }

  const [toImport] = await db
    .select()
    .from(importsTable)
    .where(eq(importsTable.id, importId));
  if (!toImport) {
    res.status(404).json({ error: "Import not found" });
    return;
  }

  const filterObj = filters ?? {};
  const isFiltered = filtersActive(filterObj);

  // The cache represents the canonical whole-import report against the default
  // (previous-import) baseline. A custom `compareTo` changes the throughput
  // baseline, so it must never read or write that cache.
  const cacheable = !isFiltered && compareTo == null;

  // Serve the advisory cache for whole-import reports unless asked to regenerate.
  if (cacheable && !regenerate && toImport.aiReport) {
    const cachedParse = AiReportResponse.safeParse(toImport.aiReport);
    if (cachedParse.success) {
      res.json({ ...cachedParse.data, cached: true });
      return;
    }
    // Stale/incompatible cache shape: fall through and regenerate.
  }

  // Resolve the base import for throughput: explicit compareTo, else previous.
  let fromImport: typeof toImport | undefined;
  if (compareTo != null) {
    const [base] = await db
      .select()
      .from(importsTable)
      .where(eq(importsTable.id, compareTo));
    if (!base) {
      res.status(404).json({ error: "Comparison import not found" });
      return;
    }
    fromImport = base;
  } else {
    const [prev] = await db
      .select()
      .from(importsTable)
      .where(lt(importsTable.id, toImport.id))
      .orderBy(desc(importsTable.id))
      .limit(1);
    fromImport = prev;
  }

  const fullMembership = await loadMembershipLite(toImport.id);
  const membership = isFiltered ? applyFilters(fullMembership, filterObj) : fullMembership;

  // Throughput deltas use the unfiltered baseline (momentum is import-wide).
  let changeSet: ChangeSet | null = null;
  if (fromImport && !isFiltered) {
    const prevMembership = await loadMembershipLite(fromImport.id);
    changeSet = buildChangeSet(
      prevMembership,
      fullMembership,
      { id: fromImport.id, label: fromImport.label },
      { id: toImport.id, label: toImport.label },
    );
  }

  const pack = buildAnalyticsPack(
    membership,
    { importId: toImport.id, importLabel: toImport.label, filtered: isFiltered },
    changeSet,
    !isFiltered && fromImport ? { id: fromImport.id, label: fromImport.label } : null,
  );

  const system =
    "You are a fabrication-operations analyst for a steel-fabrication workshop. Your single " +
    "goal is REDUCING TURNAROUND TIME. A deterministic engine has ALREADY computed every " +
    "figure in the analytics pack below (ageing = today - assign date, weights in tonnes); you " +
    "ONLY analyze it - you never recompute, never change values, and never invent data not in " +
    "the pack. Identify: red flags where inventory is held up (weight/qty stuck and ageing " +
    "fast); bottleneck process stage(s) and contractor(s) throttling flow (high aged WIP, large " +
    "share of weight, oldest items concentrated there); crucial turnaround parameters (aged-WIP " +
    "%, stage dwell, contractor lead-time spread, WIP concentration, completion-vs-intake " +
    "momentum); and cross-cutting risks (single points of failure, rework signals such as qty " +
    "increases or backward route moves, and data gaps that hide problems). Tie EVERY finding to " +
    "a specific number from the pack and cite the stage/contractor/job and figure. Activities " +
    "are process codes (e.g. Q = Quality). Respond with STRICT JSON only - no prose, no code " +
    "fences - shaped EXACTLY as: " +
    '{"summary":{"headline":string,"health":"good"|"watch"|"critical","topRisks":' +
    '[{"title":string,"severity":"high"|"med"|"low","metric":string,"why":string}]},' +
    '"actionPlan":[{"priority":number,"action":string,"target":string,"rationale":string,' +
    '"expectedImpact":string,"effort":"low"|"med"|"high","horizon":"now"|"week"|"month"}],' +
    '"detailed":{"bottlenecks":[{"area":"activity"|"contractor"|"job"|"structure","name":string,' +
    '"metric":string,"finding":string}],"ageingAnalysis":string,"contractorAnalysis":string,' +
    '"throughput":string,"dataQuality":[string],"assumptions":[string]}}. ' +
    "topRisks has 3-6 items; actionPlan is ordered most-impactful-first.";

  const user =
    "Analytics pack (deterministic; already computed - analyze, do not recompute):\n" +
    JSON.stringify(pack);

  const result = await callClaude({
    model: AI_MODEL_DEEP,
    system,
    user,
    maxTokens: 8192,
  });
  if (!result.ok) {
    req.log.warn({ importId }, "AI report call failed");
    res.json(unavailableReport());
    return;
  }

  const body = coerceReport(parseJsonObject(result.text));
  const report = {
    available: true,
    generatedAt: new Date().toISOString(),
    importId: toImport.id,
    model: AI_MODEL_DEEP,
    filtered: isFiltered,
    cached: false,
    summary: body.summary,
    actionPlan: body.actionPlan,
    detailed: body.detailed,
  };

  // Validate against the API contract before caching/returning. coerceReport
  // already normalizes the model output, so a failure here means a contract
  // drift, not malformed model JSON; fail safe rather than emit an off-contract body.
  const validated = AiReportResponse.safeParse(report);
  if (!validated.success) {
    req.log.warn({ importId, err: validated.error.message }, "AI report failed contract validation");
    res.json(unavailableReport());
    return;
  }

  // Cache only the canonical whole-import report (default baseline). Filtered
  // slices and custom comparisons vary too much to cache.
  if (cacheable) {
    try {
      await db
        .update(importsTable)
        .set({ aiReport: validated.data })
        .where(eq(importsTable.id, toImport.id));
    } catch (err) {
      req.log.warn({ importId, err }, "Failed to cache AI report");
    }
  }

  res.json(validated.data);
});

export default router;
