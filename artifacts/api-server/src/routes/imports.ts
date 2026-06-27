import { randomUUID } from "node:crypto";
import { Router, type IRouter, type RequestHandler } from "express";
import multer from "multer";
import { requireAuth } from "./auth";
import { desc, eq, lt, inArray, sql, and, isNull } from "drizzle-orm";
import {
  db,
  importsTable,
  recordPoolTable,
  importRowsTable,
  uploadStagingTable,
  settingsTable,
  rsjThicknessTable,
  manualThicknessTable,
  SETTINGS_SINGLETON_ID,
  type InsertRecordPool,
  type ChangeSummary,
  type RecordPoolRow,
} from "@workspace/db";
import {
  GetImportParams,
  GetImportRecordsParams,
  GetImportChangesParams,
  GetImportMovementParams,
  GetImportVelocityParams,
  DeleteImportParams,
  CompareImportsQueryParams,
} from "@workspace/api-zod";
import {
  activityRank,
  isKnownActivity,
  migrateTurnaroundSettings,
  velocityForMark,
  rankIn,
  sequenceForCategory,
  resolveThickness,
  buildRsjBaseIndex,
  type VelocitySnapshot,
  type TurnaroundSettings,
  type ActivitySequence,
  type ThicknessLookups,
} from "@workspace/domain";
import { recomputeMilestones } from "../lib/milestones";
import {
  parseWorkbook,
  readStructural,
  computeAgeing,
  computeRoute,
  CLEANABLE_FIELDS,
  isTruncatingCleanup,
  type Cleanup,
} from "../lib/parse";
import {
  buildChangeSet,
  type MembershipRow,
  type PoolRowLite,
} from "../lib/diff";
import {
  AI_MODEL_STANDARD,
  isAiAvailable,
  callClaude,
  parseJsonObject,
} from "../lib/ai";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const uploadSingle: RequestHandler = (req, res, next) => {
  upload.single("file")(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      res.status(status).json({ error: `Upload error: ${err.message}` });
      return;
    }
    if (err) {
      res.status(400).json({ error: "Could not read the uploaded file" });
      return;
    }
    next();
  });
};

const router: IRouter = Router();

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function poolToLite(r: RecordPoolRow): PoolRowLite {
  return {
    hash: r.hash,
    job: r.job,
    structure: r.structure,
    markTail: r.markTail,
    markId: r.markId,
    jobCardNo: r.jobCardNo,
    contractor: r.contractor,
    section: r.section,
    assignDate: r.assignDate,
    lastProductionDate: r.lastProductionDate,
    activity: r.activity,
    operation: r.operation,
    balanceQty: r.balanceQty,
    balanceWt: r.balanceWt,
  };
}

// Load the expanded membership (pool rows + copies) for an import.
async function loadMembership(
  executor: typeof db | Tx,
  importId: number,
): Promise<{ pool: RecordPoolRow; copies: number }[]> {
  const rows = await executor
    .select({ pool: recordPoolTable, copies: importRowsTable.copies })
    .from(importRowsTable)
    .innerJoin(recordPoolTable, eq(importRowsTable.poolId, recordPoolTable.id))
    .where(eq(importRowsTable.importId, importId));
  return rows;
}

function toMembershipRows(
  rows: { pool: RecordPoolRow; copies: number }[],
): MembershipRow[] {
  return rows.map((r) => ({ row: poolToLite(r.pool), copies: r.copies }));
}

// ---------------------------------------------------------------------------
// Movement (stalled) detection support
// ---------------------------------------------------------------------------
// Identity key matches the diff engine (markId + jobCardNo) so movement lines up
// with the change log.
function movementIdentityKey(
  markId: string,
  jobCardNo: string | null,
): string {
  return [markId, jobCardNo ?? ""].join("\u0001");
}

interface IdentityState {
  markId: string;
  jobCardNo: string | null;
  // Signature = sorted distinct activities + sorted distinct last-production
  // dates for this identity. A change in EITHER counts as movement.
  sig: string;
}

// Load a light per-identity signature map for one import (no full record
// expansion). Used to walk history backwards for stalled detection.
async function loadIdentityStates(
  importId: number,
): Promise<Map<string, IdentityState>> {
  const rows = await db
    .select({
      markId: recordPoolTable.markId,
      jobCardNo: recordPoolTable.jobCardNo,
      activity: recordPoolTable.activity,
      lastProductionDate: recordPoolTable.lastProductionDate,
    })
    .from(importRowsTable)
    .innerJoin(recordPoolTable, eq(importRowsTable.poolId, recordPoolTable.id))
    .where(eq(importRowsTable.importId, importId));

  const acts = new Map<string, Set<string>>();
  const lpds = new Map<string, Set<string>>();
  const meta = new Map<string, { markId: string; jobCardNo: string | null }>();
  for (const r of rows) {
    const key = movementIdentityKey(r.markId, r.jobCardNo);
    if (!meta.has(key)) {
      meta.set(key, { markId: r.markId, jobCardNo: r.jobCardNo });
      acts.set(key, new Set<string>());
      lpds.set(key, new Set<string>());
    }
    acts.get(key)!.add((r.activity ?? "").trim().toUpperCase());
    lpds.get(key)!.add(r.lastProductionDate ?? "");
  }

  const out = new Map<string, IdentityState>();
  for (const [key, m] of meta) {
    const a = Array.from(acts.get(key)!).sort().join(",");
    const l = Array.from(lpds.get(key)!).sort().join(",");
    out.set(key, { markId: m.markId, jobCardNo: m.jobCardNo, sig: `${a}\u0002${l}` });
  }
  return out;
}

// Whole days between an import's createdAt and now (>= 0).
function daysSince(createdAt: Date | string): number {
  const t = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

// Rebuild a ChangeSet-shaped object from an import's stored changeSummary. Used
// only for the idempotent commit re-return (a duplicate/retried commit): the
// per-item arrays are not reconstructed (they are not needed to acknowledge an
// already-applied import), but the counts/labels are accurate.
function changeSetFromImport(imp: typeof importsTable.$inferSelect) {
  const cs = imp.changeSummary;
  return {
    fromImportId: cs?.prevImportId ?? null,
    toImportId: imp.id,
    fromLabel: null,
    toLabel: imp.label,
    counts: {
      addedRows: cs?.addedRows ?? 0,
      unchangedRows: cs?.unchangedRows ?? 0,
      movedActivity: cs?.movedActivity ?? 0,
      qtyChanged: cs?.qtyChanged ?? 0,
      newMarks: cs?.newMarks ?? 0,
      completed: cs?.completed ?? 0,
    },
    netPendingQtyChange: cs?.netPendingQtyChange ?? 0,
    netPendingWtChange: cs?.netPendingWtChange ?? 0,
    movedActivity: [],
    qtyChanged: [],
    newMarks: [],
    completed: [],
    flags: cs?.flags ?? [],
  };
}

function serializeRecord(
  r: RecordPoolRow,
  importId: number,
  id: number,
  thicknessLookups: ThicknessLookups = {},
) {
  const { routeSteps, currentStepIndex } = computeRoute(r.operation, r.activity);
  const { thicknessMm, thicknessSource } = resolveThickness(
    {
      category: r.category,
      ntltSubtype: r.ntltSubtype,
      section: r.section,
      groupKey: r.groupKey,
      markId: r.markId,
    },
    thicknessLookups,
  );
  return {
    id,
    importId,
    hash: r.hash,
    markId: r.markId,
    job: r.job,
    structure: r.structure,
    markTail: r.markTail,
    mNo: r.mNo,
    proMno: r.proMno,
    projectSuffix: r.projectSuffix,
    aliasCorrected: r.aliasCorrected,
    markNumber: r.markNumber,
    markNo: r.markNo,
    alias: r.alias,
    section: r.section,
    jobCardNo: r.jobCardNo,
    towerType: r.towerType,
    towerSubType: r.towerSubType,
    length: r.length,
    width: r.width,
    wtPcs: r.wtPcs,
    balanceQty: r.balanceQty,
    balanceWt: r.balanceWt,
    activity: r.activity,
    operation: r.operation,
    assignDate: r.assignDate,
    lastProductionDate: r.lastProductionDate,
    contractor: r.contractor,
    orderNature: r.orderNature,
    refJobCardNo: r.refJobCardNo,
    ageingDays: computeAgeing(r.activity, r.assignDate, r.lastProductionDate),
    routeSteps,
    currentStepIndex,
    category: r.category,
    ntltSubtype: r.ntltSubtype,
    groupType: r.groupType,
    groupKey: r.groupKey,
    active: r.active,
    thicknessMm,
    thicknessSource,
  };
}

// Load the two thickness config maps (RSJ lookup by group key + manual pins by
// mark_id) so records can be resolved live, exactly like ageing. Read-only.
async function loadThicknessLookups(): Promise<ThicknessLookups> {
  const [rsjRows, manualRows] = await Promise.all([
    db.select().from(rsjThicknessTable),
    db.select().from(manualThicknessTable),
  ]);
  const rsjByKey = new Map(rsjRows.map((r) => [r.groupKey, r.thicknessMm]));
  const { rsjBaseByKey, ambiguousRsjBases } = buildRsjBaseIndex(rsjByKey);
  return {
    rsjByKey,
    manualByMarkId: new Map(manualRows.map((r) => [r.markId, r.thicknessMm])),
    rsjBaseByKey,
    ambiguousRsjBases,
  };
}

interface MergeLogger {
  warn: (obj: unknown, msg: string) => void;
}

// The append-only merge: collapse parsed rows to a per-hash multiset, insert the
// new import, ensure pool rows exist (dedup across uploads), record membership,
// and compute the change set versus the previous import. Shared by the direct
// upload route and the staged-commit route so both behave identically.
async function mergeImport(
  parsed: ReturnType<typeof parseWorkbook>,
  meta: { label: string | null; reportDate: string | null; sourceFilename: string },
  log: MergeLogger,
) {
  const multiset = new Map<
    string,
    { count: number; row: (typeof parsed.rows)[number] }
  >();
  for (const row of parsed.rows) {
    const entry = multiset.get(row.hash);
    if (entry) entry.count += 1;
    else multiset.set(row.hash, { count: 1, row });
  }

  return db.transaction(async (tx) => {
    // Serialize concurrent uploads so each import's "previous import" baseline
    // and pool insertions are computed against a stable, committed state.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(728041)`);

    // Previous import = the most recent existing import (append-only ledger).
    const [prevImport] = await tx
      .select()
      .from(importsTable)
      .orderBy(desc(importsTable.id))
      .limit(1);

    const [imp] = await tx
      .insert(importsTable)
      .values({
        label: meta.label,
        sourceFilename: meta.sourceFilename,
        reportDate: meta.reportDate,
        summary: parsed.summary,
      })
      .returning();

    // Ensure pool rows exist for every distinct hash (immutable, deduped).
    const hashes = Array.from(multiset.keys());
    const poolIdByHash = new Map<string, number>();
    const existing = await tx
      .select({ id: recordPoolTable.id, hash: recordPoolTable.hash })
      .from(recordPoolTable)
      .where(inArray(recordPoolTable.hash, hashes));
    for (const e of existing) poolIdByHash.set(e.hash, e.id);

    const toInsert: InsertRecordPool[] = [];
    for (const [hash, { row }] of multiset) {
      if (poolIdByHash.has(hash)) continue;
      toInsert.push(row as InsertRecordPool);
    }
    const chunk = 500;
    for (let i = 0; i < toInsert.length; i += chunk) {
      const inserted = await tx
        .insert(recordPoolTable)
        .values(toInsert.slice(i, i + chunk))
        .onConflictDoNothing({ target: recordPoolTable.hash })
        .returning({ id: recordPoolTable.id, hash: recordPoolTable.hash });
      for (const e of inserted) poolIdByHash.set(e.hash, e.id);
    }

    // Resolve any hashes that already existed (conflict => no row returned).
    const unresolved = hashes.filter((h) => !poolIdByHash.has(h));
    for (let i = 0; i < unresolved.length; i += chunk) {
      const found = await tx
        .select({ id: recordPoolTable.id, hash: recordPoolTable.hash })
        .from(recordPoolTable)
        .where(inArray(recordPoolTable.hash, unresolved.slice(i, i + chunk)));
      for (const e of found) poolIdByHash.set(e.hash, e.id);
    }

    // Record this import's membership with multiplicities.
    const memberships = Array.from(multiset.entries()).map(
      ([hash, { count }]) => ({
        importId: imp.id,
        poolId: poolIdByHash.get(hash)!,
        copies: count,
      }),
    );
    for (let i = 0; i < memberships.length; i += chunk) {
      await tx.insert(importRowsTable).values(memberships.slice(i, i + chunk));
    }

    // Build the change set versus the previous import.
    const nextMembership: MembershipRow[] = Array.from(multiset.values()).map(
      ({ count, row }) => ({
        row: poolToLite(row as unknown as RecordPoolRow),
        copies: count,
      }),
    );
    const prevMembership = prevImport
      ? toMembershipRows(await loadMembership(tx, prevImport.id))
      : [];

    const changeSet = buildChangeSet(
      prevMembership,
      nextMembership,
      prevImport ? { id: prevImport.id, label: prevImport.label } : null,
      { id: imp.id, label: imp.label },
    );

    const changeSummary: ChangeSummary = {
      prevImportId: changeSet.fromImportId,
      addedRows: changeSet.counts.addedRows,
      unchangedRows: changeSet.counts.unchangedRows,
      movedActivity: changeSet.counts.movedActivity,
      qtyChanged: changeSet.counts.qtyChanged,
      newMarks: changeSet.counts.newMarks,
      completed: changeSet.counts.completed,
      netPendingQtyChange: changeSet.netPendingQtyChange,
      netPendingWtChange: changeSet.netPendingWtChange,
      flags: changeSet.flags,
    };

    // Deterministic self-checks (advisory; logged, never block the import).
    const conservationOk =
      changeSummary.addedRows + changeSummary.unchangedRows ===
      parsed.summary.rowsKept;
    if (!conservationOk) {
      log.warn(
        {
          importId: imp.id,
          addedRows: changeSummary.addedRows,
          unchangedRows: changeSummary.unchangedRows,
          rowsKept: parsed.summary.rowsKept,
        },
        "Self-check failed: added + unchanged != rowsKept",
      );
    }
    if (
      changeSummary.addedRows === 0 &&
      (changeSummary.newMarks > 0 ||
        changeSummary.movedActivity > 0 ||
        changeSummary.qtyChanged > 0)
    ) {
      log.warn(
        { importId: imp.id },
        "Self-check anomaly: 0 added rows but item-level changes detected",
      );
    }

    const [withSummary] = await tx
      .update(importsTable)
      .set({ changeSummary })
      .where(eq(importsTable.id, imp.id))
      .returning();

    return { import: withSummary, changeSet };
  });
}

router.get("/imports", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(importsTable)
    .orderBy(desc(importsTable.createdAt));
  res.json(rows);
});

router.post("/imports", requireAuth, uploadSingle, async (req, res): Promise<void> => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }

  const labelRaw =
    typeof req.body?.label === "string" ? req.body.label.trim() : "";
  const label = labelRaw.length > 0 ? labelRaw : null;

  const reportDateRaw =
    typeof req.body?.reportDate === "string" ? req.body.reportDate.trim() : "";
  const reportDate = /^\d{4}-\d{2}-\d{2}$/.test(reportDateRaw)
    ? reportDateRaw
    : null;

  let parsed;
  try {
    parsed = parseWorkbook(file.buffer);
  } catch (err) {
    req.log.warn({ err }, "Failed to parse workbook");
    res
      .status(400)
      .json({ error: "Could not parse the uploaded file as an .xlsx report" });
    return;
  }

  if (parsed.rows.length === 0) {
    res.status(400).json({
      error:
        "No marks found in the file. Check that the sheet has a header on the third row and a 'Mark No.' column.",
    });
    return;
  }

  const result = await mergeImport(
    parsed,
    { label, reportDate, sourceFilename: file.originalname },
    req.log,
  );

  // Refresh permanent project milestones (capture-once; best-effort).
  try {
    await recomputeMilestones();
  } catch (err) {
    req.log.warn({ err }, "Milestone recompute failed after import");
  }

  res.status(201).json(result);
});

// ---------------------------------------------------------------------------
// Staged upload + AI gatekeeper flow (stage -> validate -> commit).
//
// NOTHING is written to the engine (record_pool / import_rows / imports) until
// the user accepts and commit() runs parse+merge. Staged bytes live in
// upload_staging and are removed on commit, discard, or expiry. The AI layer is
// advisory only: with no key the app still works (validate reports
// available:false and the UI offers "import as-is").
// ---------------------------------------------------------------------------

const STAGING_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_GATEKEEPER_ROWS = 400;

// Opportunistically drop staged rows older than the TTL.
async function expireStagedUploads(): Promise<void> {
  const cutoff = new Date(Date.now() - STAGING_TTL_MS);
  await db.delete(uploadStagingTable).where(lt(uploadStagingTable.createdAt, cutoff));
}

// POST /imports/stage — accept ANY file; store bytes and return a structural
// (AI-free) read. Never parses into the engine.
router.post("/imports/stage", requireAuth, uploadSingle, async (req, res): Promise<void> => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }

  const labelRaw =
    typeof req.body?.label === "string" ? req.body.label.trim() : "";
  const label = labelRaw.length > 0 ? labelRaw : null;

  const reportDateRaw =
    typeof req.body?.reportDate === "string" ? req.body.reportDate.trim() : "";
  const reportDate = /^\d{4}-\d{2}-\d{2}$/.test(reportDateRaw)
    ? reportDateRaw
    : null;

  await expireStagedUploads();

  const stagingId = randomUUID();
  await db.insert(uploadStagingTable).values({
    id: stagingId,
    sourceFilename: file.originalname,
    label,
    reportDate,
    fileData: file.buffer,
  });

  let structural;
  try {
    structural = readStructural(file.buffer);
  } catch (err) {
    req.log.warn({ err }, "Structural read failed for staged upload");
    structural = {
      sheetName: null,
      headerRow: null,
      columnsFound: [],
      missingColumns: [],
      rowsRead: 0,
      rowsWithMark: 0,
      problems: ["The file could not be read as a spreadsheet."],
    };
  }

  res.status(201).json({
    stagingId,
    sourceFilename: file.originalname,
    structural,
  });
});

// POST /imports/validate — run the Claude gatekeeper over a staged file. Returns
// a verdict (ok/reject) plus optional descriptive-only sanitize suggestions.
// With no key (or on any AI failure) returns available:false so the UI can offer
// "import as-is".
router.post("/imports/validate", requireAuth, async (req, res): Promise<void> => {
  const stagingId =
    typeof req.body?.stagingId === "string" ? req.body.stagingId : "";
  if (!stagingId) {
    res.status(400).json({ error: "stagingId is required" });
    return;
  }

  const [staged] = await db
    .select()
    .from(uploadStagingTable)
    .where(eq(uploadStagingTable.id, stagingId));
  if (!staged) {
    res.status(404).json({ error: "Staged upload not found" });
    return;
  }

  const unavailable = {
    available: false,
    verdict: null,
    reason: null,
    expectedShape: null,
    sanitize: [],
  };

  if (!isAiAvailable()) {
    res.json(unavailable);
    return;
  }

  // Parse WITHOUT cleanups to build a bounded, descriptive-only sample.
  let parsed;
  try {
    parsed = parseWorkbook(staged.fileData);
  } catch (err) {
    req.log.warn({ err, stagingId }, "Validate parse failed");
    res.json({
      available: true,
      verdict: "reject",
      reason: "The file could not be parsed as an .xlsx balance/activity report.",
      expectedShape:
        "An .xlsx export with a header row containing 'Project Code' and a 'Mark No.' column.",
      sanitize: [],
    });
    return;
  }

  const structural = readStructural(staged.fileData);

  // Distinct descriptive sample, capped for a bounded prompt.
  const seen = new Set<string>();
  const sample: Record<string, string | null>[] = [];
  for (const row of parsed.rows) {
    if (sample.length >= MAX_GATEKEEPER_ROWS) break;
    const o: Record<string, string | null> = {};
    for (const f of CLEANABLE_FIELDS) {
      o[f] = (row[f as keyof typeof row] as string | null) ?? null;
    }
    const key = JSON.stringify(o);
    if (seen.has(key)) continue;
    seen.add(key);
    sample.push(o);
  }

  const system =
    "You are a strict gatekeeper for a steel-fabrication balance/activity report " +
    "before it is imported into a deterministic engine. You NEVER modify data and " +
    "you NEVER recompute results. Decide if the file is a valid report of this kind. " +
    "Reject only when the file is clearly the wrong kind of document (missing the " +
    "expected columns, empty, or not a balance/activity report). If it is a valid " +
    "report, return verdict 'ok'. You MAY additionally suggest descriptive-only " +
    "cleanups for these fields and NOTHING else: " +
    CLEANABLE_FIELDS.join(", ") +
    ". Never suggest changes to mark identity, quantities, weights, activity, or " +
    "operation. For name fields (contractor, section, and any other non-date " +
    "field) ONLY fix whitespace, punctuation spacing, and casing. NEVER remove or " +
    "shorten any suffix, unit designation, branch code, parenthetical, or " +
    "hyphenated tag (e.g. GP-2, UNIT-II, (JW), - JW, BDM). Names that differ only " +
    "by such a tag are DIFFERENT contractors and must be kept separate — do not " +
    "merge them. If the only difference between two names is real text tokens, " +
    "make no suggestion. For assignDate only, normalize to YYYY-MM-DD. " +
    "Respond with STRICT JSON only, no prose, no code fences, shaped exactly as: " +
    '{"verdict":"ok"|"reject","reason":string|null,"expectedShape":string|null,' +
    '"sanitize":[{"field":string,"from":string|null,"to":string|null,' +
    '"reason":string}]}. On reject, set reason and expectedShape and leave ' +
    "sanitize empty.";

  const user =
    "Structural read (already computed, AI-free):\n" +
    JSON.stringify(structural) +
    "\n\nDistinct descriptive sample (one object per distinct combination, capped):\n" +
    JSON.stringify(sample);

  const result = await callClaude({ model: AI_MODEL_STANDARD, system, user });
  if (!result.ok) {
    req.log.warn({ stagingId }, "AI validate call failed");
    res.json(unavailable);
    return;
  }

  const obj = parseJsonObject(result.text);
  const o = obj && typeof obj === "object" ? (obj as Record<string, unknown>) : {};
  const verdict = o.verdict === "reject" ? "reject" : "ok";
  const reason = typeof o.reason === "string" ? o.reason : null;
  const expectedShape =
    typeof o.expectedShape === "string" ? o.expectedShape : null;

  // Count, per (field, from), how many staged rows currently match — so the UI
  // can show the blast radius. Also enforce the descriptive allow-list.
  const allowed = new Set<string>(CLEANABLE_FIELDS);
  const sanitize: {
    field: string;
    from: string | null;
    to: string | null;
    reason: string;
    count: number;
  }[] = [];

  if (verdict === "ok" && Array.isArray(o.sanitize)) {
    for (const s of o.sanitize) {
      if (!s || typeof s !== "object") continue;
      const field = (s as { field?: unknown }).field;
      if (typeof field !== "string" || !allowed.has(field)) continue;
      const fromRaw = (s as { from?: unknown }).from;
      const toRaw = (s as { to?: unknown }).to;
      const from =
        typeof fromRaw === "string" ? fromRaw : fromRaw === null ? null : null;
      const to = typeof toRaw === "string" ? toRaw : toRaw === null ? null : null;
      if (to === from) continue;
      // Block truncating/merging name changes (e.g. dropping "GP-2"/"(UNIT-II)")
      // server-side so they never reach the user even if the model proposes them.
      if (isTruncatingCleanup(field, from, to)) {
        req.log.warn(
          { stagingId, field, from, to },
          "Dropped truncating sanitize suggestion (token set changed)",
        );
        continue;
      }
      const reasonRaw = (s as { reason?: unknown }).reason;
      let count = 0;
      for (const row of parsed.rows) {
        const cur = (row[field as keyof typeof row] as string | null) ?? null;
        if (cur === from) count++;
      }
      if (count === 0) continue;
      sanitize.push({
        field,
        from,
        to,
        reason: typeof reasonRaw === "string" ? reasonRaw : "Suggested cleanup",
        count,
      });
    }
  }

  res.json({
    available: true,
    verdict,
    reason: verdict === "reject" ? reason : null,
    expectedShape: verdict === "reject" ? expectedShape : null,
    sanitize: verdict === "ok" ? sanitize : [],
  });
});

// POST /imports/commit — apply any accepted descriptive cleanups, then run the
// real parse+merge into the engine. Deletes the staged row on success.
router.post("/imports/commit", requireAuth, async (req, res): Promise<void> => {
  const stagingId =
    typeof req.body?.stagingId === "string" ? req.body.stagingId : "";
  if (!stagingId) {
    res.status(400).json({ error: "stagingId is required" });
    return;
  }

  const allowed = new Set<string>(CLEANABLE_FIELDS);
  const accepted: Cleanup[] = [];
  if (Array.isArray(req.body?.acceptedSuggestions)) {
    for (const s of req.body.acceptedSuggestions) {
      if (!s || typeof s !== "object") continue;
      const field = (s as { field?: unknown }).field;
      if (typeof field !== "string" || !allowed.has(field)) continue;
      const fromRaw = (s as { from?: unknown }).from;
      const toRaw = (s as { to?: unknown }).to;
      const from = typeof fromRaw === "string" ? fromRaw : null;
      const to = typeof toRaw === "string" ? toRaw : null;
      // Defense in depth: reject truncating/merging name changes even if a
      // caller posts them directly to commit (bypassing /validate).
      if (isTruncatingCleanup(field, from, to)) {
        req.log.warn(
          { stagingId, field, from, to },
          "Dropped truncating cleanup at commit (token set changed)",
        );
        continue;
      }
      accepted.push({ field, from, to });
    }
  }

  const [staged] = await db
    .select()
    .from(uploadStagingTable)
    .where(eq(uploadStagingTable.id, stagingId));
  if (!staged) {
    res.status(404).json({ error: "Staged upload not found" });
    return;
  }

  // Idempotency: this staged file was already committed (e.g. a proxy/timeout
  // retry of a slow commit, or a double submit). Return the existing import
  // instead of re-merging or failing with a misleading error.
  if (staged.committedImportId != null) {
    const [imp] = await db
      .select()
      .from(importsTable)
      .where(eq(importsTable.id, staged.committedImportId));
    if (imp) {
      req.log.info(
        { stagingId, importId: imp.id },
        "Commit replayed: staged file already committed",
      );
      res.status(200).json({ import: imp, changeSet: changeSetFromImport(imp) });
      return;
    }
    // The committed import was later deleted; fall through and re-commit.
  }

  let parsed;
  try {
    parsed = parseWorkbook(staged.fileData, accepted);
  } catch (err) {
    req.log.warn({ err, stagingId }, "Commit parse failed");
    res
      .status(400)
      .json({ error: "Could not parse the staged file as an .xlsx report" });
    return;
  }

  if (parsed.rows.length === 0) {
    res.status(400).json({
      error:
        "No marks found in the file. Check that the sheet has a header row with 'Project Code' and a 'Mark No.' column.",
    });
    return;
  }

  const result = await mergeImport(
    parsed,
    {
      label: staged.label,
      reportDate: staged.reportDate,
      sourceFilename: staged.sourceFilename,
    },
    req.log,
  );

  // Atomically claim this staged row for the import we just created. Only the
  // first commit to reach here wins (committed_import_id IS NULL); a concurrent
  // duplicate that also merged loses the claim, so we discard its orphan import
  // and return the winner's — guaranteeing one import per staged file.
  const claimed = await db
    .update(uploadStagingTable)
    .set({ committedImportId: result.import.id })
    .where(
      and(
        eq(uploadStagingTable.id, stagingId),
        isNull(uploadStagingTable.committedImportId),
      ),
    )
    .returning({ id: uploadStagingTable.id });

  if (claimed.length === 0) {
    // Lost the race: another concurrent commit already claimed this staged file.
    // Resolve the winner FIRST; only drop our orphan import once a real winner
    // is confirmed, so we never return a deleted import.
    const [winnerRow] = await db
      .select({ committedImportId: uploadStagingTable.committedImportId })
      .from(uploadStagingTable)
      .where(eq(uploadStagingTable.id, stagingId));
    const winnerId = winnerRow?.committedImportId ?? null;
    const [winner] =
      winnerId != null && winnerId !== result.import.id
        ? await db
            .select()
            .from(importsTable)
            .where(eq(importsTable.id, winnerId))
        : [];
    if (winner) {
      // Roll back the duplicate import we just created (cascades its
      // import_rows; the shared record pool is permanent and untouched).
      await db.delete(importsTable).where(eq(importsTable.id, result.import.id));
      req.log.warn(
        { stagingId, droppedImportId: result.import.id, importId: winner.id },
        "Concurrent commit detected: dropped duplicate import",
      );
      res
        .status(200)
        .json({ import: winner, changeSet: changeSetFromImport(winner) });
      return;
    }
    // Could not resolve a distinct winner (e.g. the row was discarded mid-flight
    // or the winner import vanished). Keep the import we just built and return
    // it rather than emitting a phantom (deleted) import.
    req.log.warn(
      { stagingId, importId: result.import.id },
      "Commit claim not recorded but no distinct winner found; keeping import",
    );
  }

  // Refresh permanent project milestones (capture-once; best-effort).
  try {
    await recomputeMilestones();
  } catch (err) {
    req.log.warn({ err }, "Milestone recompute failed after commit");
  }

  res.status(201).json(result);
});

// DELETE /imports/stage/:id — discard a staged upload without committing.
router.delete("/imports/stage/:id", requireAuth, async (req, res): Promise<void> => {
  const id = String(req.params.id);
  await db.delete(uploadStagingTable).where(eq(uploadStagingTable.id, id));
  res.status(204).end();
});

router.get("/imports/compare", async (req, res): Promise<void> => {
  const params = CompareImportsQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const { from, to } = params.data;

  const [toImport] = await db
    .select()
    .from(importsTable)
    .where(eq(importsTable.id, to));
  if (!toImport) {
    res.status(404).json({ error: "Target import not found" });
    return;
  }
  const [fromImport] = await db
    .select()
    .from(importsTable)
    .where(eq(importsTable.id, from));
  if (!fromImport) {
    res.status(404).json({ error: "Base import not found" });
    return;
  }

  const changeSet = buildChangeSet(
    toMembershipRows(await loadMembership(db, fromImport.id)),
    toMembershipRows(await loadMembership(db, toImport.id)),
    { id: fromImport.id, label: fromImport.label },
    { id: toImport.id, label: toImport.label },
  );
  res.json(changeSet);
});

router.get("/imports/:id", async (req, res): Promise<void> => {
  const params = GetImportParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [imp] = await db
    .select()
    .from(importsTable)
    .where(eq(importsTable.id, params.data.id));

  if (!imp) {
    res.status(404).json({ error: "Import not found" });
    return;
  }

  res.json(imp);
});

router.delete("/imports", requireAuth, async (req, res): Promise<void> => {
  const result = await db.transaction(async (tx) => {
    // Serialize against concurrent uploads (which take the same lock) so a reset
    // can never interleave with an upload and leave a partial/inconsistent state.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(728041)`);
    const deletedImports = await tx.delete(importsTable).returning({ id: importsTable.id });
    const deletedPool = await tx.delete(recordPoolTable).returning({ id: recordPoolTable.id });
    return {
      importsDeleted: deletedImports.length,
      poolRowsDeleted: deletedPool.length,
    };
  });

  req.log.info(result, "deleted all imports and record pool");
  res.json(result);
});

router.delete("/imports/:id", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteImportParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(importsTable)
    .where(eq(importsTable.id, params.data.id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Import not found" });
    return;
  }

  // Refresh permanent project milestones so last-seen / dispatch state stays
  // consistent after the deletion (best-effort; never fails the request).
  try {
    await recomputeMilestones();
  } catch (err) {
    req.log.warn({ err }, "Milestone recompute failed after import delete");
  }

  res.sendStatus(204);
});

router.get("/imports/:id/records", async (req, res): Promise<void> => {
  const params = GetImportRecordsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [imp] = await db
    .select({ id: importsTable.id })
    .from(importsTable)
    .where(eq(importsTable.id, params.data.id));

  if (!imp) {
    res.status(404).json({ error: "Import not found" });
    return;
  }

  const rows = await loadMembership(db, params.data.id);
  rows.sort((a, b) => a.pool.markId.localeCompare(b.pool.markId));

  const thicknessLookups = await loadThicknessLookups();

  const out: ReturnType<typeof serializeRecord>[] = [];
  let nextId = 1;
  for (const { pool, copies } of rows) {
    for (let c = 0; c < copies; c++) {
      out.push(serializeRecord(pool, params.data.id, nextId++, thicknessLookups));
    }
  }

  res.json(out);
});

router.get("/imports/:id/changes", async (req, res): Promise<void> => {
  const params = GetImportChangesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [toImport] = await db
    .select()
    .from(importsTable)
    .where(eq(importsTable.id, params.data.id));
  if (!toImport) {
    res.status(404).json({ error: "Import not found" });
    return;
  }

  const [prevImport] = await db
    .select()
    .from(importsTable)
    .where(lt(importsTable.id, toImport.id))
    .orderBy(desc(importsTable.id))
    .limit(1);

  const changeSet = buildChangeSet(
    prevImport ? toMembershipRows(await loadMembership(db, prevImport.id)) : [],
    toMembershipRows(await loadMembership(db, toImport.id)),
    prevImport ? { id: prevImport.id, label: prevImport.label } : null,
    { id: toImport.id, label: toImport.label },
  );
  res.json(changeSet);
});

// Per-identity movement: how many days each mark in the target import has gone
// without its (activity-set + last-production-date-set) signature changing.
// Walks prior imports newest -> oldest; daysSinceLastMovement = days since the
// OLDEST consecutive prior import that still carried the same signature. null
// when there is no matching history (new mark, just changed, or no prior
// imports) -> the frontend degrades gracefully (never flags as stalled).
router.get("/imports/:id/movement", async (req, res): Promise<void> => {
  const params = GetImportMovementParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [target] = await db
    .select()
    .from(importsTable)
    .where(eq(importsTable.id, params.data.id));
  if (!target) {
    res.status(404).json({ error: "Import not found" });
    return;
  }

  const current = await loadIdentityStates(target.id);

  const priorImports = await db
    .select({ id: importsTable.id, createdAt: importsTable.createdAt })
    .from(importsTable)
    .where(lt(importsTable.id, target.id))
    .orderBy(desc(importsTable.id));

  const days = new Map<string, number | null>();
  for (const key of current.keys()) days.set(key, null);

  const stillMatching = new Set(current.keys());
  for (const imp of priorImports) {
    if (stillMatching.size === 0) break;
    const priorSigs = await loadIdentityStates(imp.id);
    const age = daysSince(imp.createdAt);
    for (const key of Array.from(stillMatching)) {
      const prior = priorSigs.get(key);
      if (prior && prior.sig === current.get(key)!.sig) {
        days.set(key, age);
      } else {
        stillMatching.delete(key);
      }
    }
  }

  const items = Array.from(current.entries()).map(([key, st]) => ({
    markId: st.markId,
    jobCardNo: st.jobCardNo,
    daysSinceLastMovement: days.get(key) ?? null,
  }));

  res.json({
    importId: target.id,
    hasHistory: priorImports.length > 0,
    items,
  });
});

// Per-identity velocity projection for ONE import (no full record expansion).
// For each mark identity it keeps a single REPRESENTATIVE row = the furthest-
// progressed activity (max activityRank). That row's stage index, last-production
// date, project, contractor and route remaining seed the snapshot series + the
// current-state inputs to the velocity engine.
interface VelocityState {
  markId: string;
  jobCardNo: string | null;
  job: string;
  contractor: string;
  activity: string;
  stageIndex: number;
  assignDate: string | null;
  lastProductionDate: string | null;
  routeRemaining: number | null;
  // The mark's process sequence (per category). stageIndex is computed against it.
  sequence: ActivitySequence;
}

async function loadVelocityStates(
  importId: number,
): Promise<Map<string, VelocityState>> {
  const rows = await db
    .select({
      markId: recordPoolTable.markId,
      jobCardNo: recordPoolTable.jobCardNo,
      job: recordPoolTable.job,
      contractor: recordPoolTable.contractor,
      activity: recordPoolTable.activity,
      operation: recordPoolTable.operation,
      assignDate: recordPoolTable.assignDate,
      lastProductionDate: recordPoolTable.lastProductionDate,
      category: recordPoolTable.category,
      ntltSubtype: recordPoolTable.ntltSubtype,
    })
    .from(importRowsTable)
    .innerJoin(recordPoolTable, eq(importRowsTable.poolId, recordPoolTable.id))
    .where(eq(importRowsTable.importId, importId));

  const out = new Map<string, VelocityState>();
  for (const r of rows) {
    const key = movementIdentityKey(r.markId, r.jobCardNo);
    const activity = (r.activity ?? "").trim();
    // stageIndex must be measured against the mark's OWN sequence (per category)
    // so NTLT marks progress along their route, not the 12-step TLT route.
    const sequence = sequenceForCategory(r.category, r.ntltSubtype);
    const rank = rankIn(sequence, activity);
    const existing = out.get(key);
    // Keep the furthest-progressed row as the representative for the identity.
    if (existing && rank <= existing.stageIndex) continue;
    const { routeSteps, currentStepIndex } = computeRoute(
      r.operation,
      r.activity,
    );
    const routeRemaining =
      routeSteps.length > 0 && currentStepIndex !== null
        ? Math.max(0, routeSteps.length - 1 - currentStepIndex)
        : null;
    out.set(key, {
      markId: r.markId,
      jobCardNo: r.jobCardNo,
      job: r.job,
      contractor: r.contractor ?? "",
      activity,
      stageIndex: rank,
      assignDate: r.assignDate,
      lastProductionDate: r.lastProductionDate,
      routeRemaining,
      sequence,
    });
  }
  return out;
}

// Epoch ms for an import's pace time-axis: report date when present, else upload
// time (createdAt). Report date is a plain YYYY-MM-DD (treated as UTC midnight).
function importDateMs(reportDate: string | null, createdAt: Date | string): number {
  if (reportDate && /^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
    const t = Date.parse(`${reportDate}T00:00:00Z`);
    if (Number.isFinite(t)) return t;
  }
  return createdAt instanceof Date
    ? createdAt.getTime()
    : new Date(createdAt).getTime();
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Per-identity velocity (pace / ETA / trend) with project / contractor / stage
// roll-ups. Walks prior imports once to build each mark's snapshot series, then
// classifies via the deterministic @workspace/domain engine. Purely advisory —
// never mutates parsing / activity / dedup / ageing / threshold math.
router.get("/imports/:id/velocity", async (req, res): Promise<void> => {
  const params = GetImportVelocityParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [target] = await db
    .select()
    .from(importsTable)
    .where(eq(importsTable.id, params.data.id));
  if (!target) {
    res.status(404).json({ error: "Import not found" });
    return;
  }

  const [settingsRow] = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.id, SETTINGS_SINGLETON_ID))
    .limit(1);
  const settings: TurnaroundSettings = migrateTurnaroundSettings(
    settingsRow
      ? {
          activities: settingsRow.activities,
          perProject: settingsRow.perProject,
          stalledDays: settingsRow.stalledDays,
        }
      : {},
  );

  const current = await loadVelocityStates(target.id);
  const currentMs = importDateMs(target.reportDate, target.createdAt);

  const priorImports = await db
    .select({
      id: importsTable.id,
      createdAt: importsTable.createdAt,
      reportDate: importsTable.reportDate,
    })
    .from(importsTable)
    .where(lt(importsTable.id, target.id))
    .orderBy(desc(importsTable.id));

  // Build per-identity snapshot series: seed with the current import, then layer
  // prior imports (only while the mark still appears) for the time axis.
  const series = new Map<string, VelocitySnapshot[]>();
  const movementSig = new Map<string, string>();
  const daysSinceMovement = new Map<string, number | null>();
  const currentSigs = await loadIdentityStates(target.id);
  for (const [key, st] of current) {
    series.set(key, [
      {
        importDate: currentMs,
        stageIndex: st.stageIndex,
        lastProductionDate: st.lastProductionDate,
      },
    ]);
    movementSig.set(key, currentSigs.get(key)?.sig ?? "");
    daysSinceMovement.set(key, null);
  }

  const stillMatching = new Set(current.keys());
  for (const imp of priorImports) {
    const priorVel = await loadVelocityStates(imp.id);
    const priorSigs = await loadIdentityStates(imp.id);
    const ms = importDateMs(imp.reportDate, imp.createdAt);
    const age = daysSince(imp.createdAt);
    for (const key of current.keys()) {
      const prior = priorVel.get(key);
      if (prior) {
        series.get(key)!.push({
          importDate: ms,
          stageIndex: prior.stageIndex,
          lastProductionDate: prior.lastProductionDate,
        });
      }
      // Stalled clock: consecutive prior imports carrying the same signature.
      if (stillMatching.has(key)) {
        const ps = priorSigs.get(key);
        if (ps && ps.sig === movementSig.get(key)) {
          daysSinceMovement.set(key, age);
        } else {
          stillMatching.delete(key);
        }
      }
    }
  }

  const items = Array.from(current.entries()).map(([key, st]) => {
    const ageingDays = computeAgeing(st.activity, st.assignDate, st.lastProductionDate);
    const v = velocityForMark(
      {
        series: series.get(key) ?? [],
        activity: st.activity,
        ageingDays,
        daysSinceLastMovement: daysSinceMovement.get(key) ?? null,
        routeRemaining: st.routeRemaining,
        project: st.job,
        sequence: st.sequence,
      },
      settings,
    );
    return {
      markId: st.markId,
      jobCardNo: st.jobCardNo,
      job: st.job,
      contractor: st.contractor,
      activity: st.activity,
      ageingDays,
      status: v.status,
      trend: v.trend,
      daysPerStage: v.daysPerStage,
      expectedDaysPerStage: v.expectedDaysPerStage,
      stagesRemaining: v.stagesRemaining,
      etaDays: v.etaDays,
      etaGap: v.etaGap,
      observedWindowDays: v.observedWindowDays,
      snapshotsUsed: v.snapshotsUsed,
      daysSinceLastMovement: v.daysSinceLastMovement,
      insufficientHistory: v.insufficientHistory,
    };
  });

  // Roll-ups. stuckScore = (stalled + 0.5*slow) / markCount (0..1).
  type Acc = {
    paces: number[];
    gaps: number[];
    stalled: number;
    slow: number;
    moving: number;
    insufficient: number;
    count: number;
  };
  const newAcc = (): Acc => ({
    paces: [],
    gaps: [],
    stalled: 0,
    slow: 0,
    moving: 0,
    insufficient: 0,
    count: 0,
  });
  const projAcc = new Map<string, Acc>();
  const contractorAcc = new Map<string, Acc>();
  const stageAcc = new Map<string, Acc>();
  const bump = (acc: Acc, it: (typeof items)[number]) => {
    acc.count++;
    if (it.daysPerStage != null) acc.paces.push(it.daysPerStage);
    if (it.etaGap != null) acc.gaps.push(it.etaGap);
    if (it.status === "stalled") acc.stalled++;
    else if (it.status === "slow") acc.slow++;
    else if (it.status === "moving") acc.moving++;
    else acc.insufficient++;
  };
  for (const it of items) {
    const p = projAcc.get(it.job) ?? newAcc();
    bump(p, it);
    projAcc.set(it.job, p);
    const c = contractorAcc.get(it.contractor) ?? newAcc();
    bump(c, it);
    contractorAcc.set(it.contractor, c);
    const sKey = (it.activity || "").trim().toUpperCase();
    const s = stageAcc.get(sKey) ?? newAcc();
    bump(s, it);
    stageAcc.set(sKey, s);
  }

  const projects = Array.from(projAcc.entries())
    .map(([project, a]) => ({
      project,
      markCount: a.count,
      stalledCount: a.stalled,
      slowCount: a.slow,
      movingCount: a.moving,
      insufficientCount: a.insufficient,
      avgDaysPerStage: mean(a.paces),
      avgEtaGap: mean(a.gaps),
      stuckScore: a.count > 0 ? (a.stalled + 0.5 * a.slow) / a.count : 0,
    }))
    .sort((x, y) => y.stuckScore - x.stuckScore || y.stalledCount - x.stalledCount);

  const contractors = Array.from(contractorAcc.entries())
    .map(([contractor, a]) => ({
      contractor,
      markCount: a.count,
      stalledCount: a.stalled,
      slowCount: a.slow,
      avgDaysPerStage: mean(a.paces),
      avgEtaGap: mean(a.gaps),
    }))
    .sort((x, y) => y.stalledCount - x.stalledCount || y.slowCount - x.slowCount);

  const stages = Array.from(stageAcc.entries())
    .map(([activity, a]) => ({
      activity,
      markCount: a.count,
      stalledCount: a.stalled,
      slowCount: a.slow,
      avgDaysPerStage: mean(a.paces),
    }))
    .sort((x, y) => activityRank(x.activity) - activityRank(y.activity));

  res.json({
    importId: target.id,
    hasHistory: priorImports.length > 0,
    windowReports: priorImports.length + 1,
    items,
    projects,
    contractors,
    stages,
  });
});

// Permanent per-project turnaround milestones (Ready for Dispatch / Dispatched).
// Recomputed deterministically from the full import history on each read (and on
// each upload); captured dates are preserved (capture-once) and persisted so
// they survive after a project leaves the report. Purely additive.
router.get("/milestones", async (_req, res): Promise<void> => {
  const items = await recomputeMilestones();
  res.json({ items, generatedAt: new Date().toISOString() });
});

export default router;
