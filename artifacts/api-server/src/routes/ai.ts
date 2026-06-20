import { Router, type IRouter } from "express";
import { eq, lt, desc } from "drizzle-orm";
import {
  db,
  importsTable,
  recordPoolTable,
  importRowsTable,
  type RecordPoolRow,
} from "@workspace/db";
import { AiSanitizeBody, AiReviewBody } from "@workspace/api-zod";
import { buildChangeSet, type MembershipRow, type ChangeSet } from "../lib/diff";
import { computeAgeing, computeRoute } from "../lib/parse";
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
      activity: pool.activity,
      operation: pool.operation,
      balanceQty: pool.balanceQty,
      balanceWt: pool.balanceWt,
    },
    copies,
  }));
}

router.post("/ai/sanitize", async (req, res): Promise<void> => {
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
    "operation, or mark identity. Suggest only when a value is clearly malformed or " +
    "inconsistent: normalize dates to YYYY-MM-DD, canonicalize inconsistent " +
    "contractor/section spellings to the most common spelling (most-common wins), " +
    "trim whitespace, and fix obvious typos. Do not suggest a change when the value " +
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
    if (s.field === "assignDate") counts.dates++;
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
  ageing: { min: number | null; max: number | null; avg: number | null; counted: number };
  activityCodes: string[];
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

  for (const { row } of membership) {
    distinctHashes.add(row.hash);
    if (row.contractor == null) nullContractor++;
    if (row.assignDate == null) nullDate++;
    const ag = computeAgeing(row.assignDate);
    if (ag !== null) {
      agSum += ag;
      agCount++;
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
    ageing: {
      min: agMin,
      max: agMax,
      avg: agCount > 0 ? Math.round(agSum / agCount) : null,
      counted: agCount,
    },
    activityCodes: Array.from(activityCodes).sort(),
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

router.post("/ai/review", async (req, res): Promise<void> => {
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
    "value. Audit: ageing math sanity, unknown/odd activity codes, activity not in " +
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

export default router;
