import { randomUUID } from "node:crypto";
import { Router, type IRouter, type RequestHandler } from "express";
import multer from "multer";
import { desc, eq, lt, inArray, sql } from "drizzle-orm";
import {
  db,
  importsTable,
  recordPoolTable,
  importRowsTable,
  uploadStagingTable,
  type InsertRecordPool,
  type ChangeSummary,
  type RecordPoolRow,
} from "@workspace/db";
import {
  GetImportParams,
  GetImportRecordsParams,
  GetImportChangesParams,
  DeleteImportParams,
  CompareImportsQueryParams,
} from "@workspace/api-zod";
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

function serializeRecord(r: RecordPoolRow, importId: number, id: number) {
  const { routeSteps, currentStepIndex } = computeRoute(r.operation, r.activity);
  return {
    id,
    importId,
    hash: r.hash,
    markId: r.markId,
    job: r.job,
    structure: r.structure,
    markTail: r.markTail,
    mNo: r.mNo,
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
    contractor: r.contractor,
    orderNature: r.orderNature,
    refJobCardNo: r.refJobCardNo,
    ageingDays: computeAgeing(r.assignDate),
    routeSteps,
    currentStepIndex,
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

router.post("/imports", uploadSingle, async (req, res): Promise<void> => {
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
router.post("/imports/stage", uploadSingle, async (req, res): Promise<void> => {
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
router.post("/imports/validate", async (req, res): Promise<void> => {
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
router.post("/imports/commit", async (req, res): Promise<void> => {
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

  // Best-effort cleanup of the staged bytes now that they are committed.
  await db
    .delete(uploadStagingTable)
    .where(eq(uploadStagingTable.id, stagingId));

  res.status(201).json(result);
});

// DELETE /imports/stage/:id — discard a staged upload without committing.
router.delete("/imports/stage/:id", async (req, res): Promise<void> => {
  const id = req.params.id;
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

router.delete("/imports", async (req, res): Promise<void> => {
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

router.delete("/imports/:id", async (req, res): Promise<void> => {
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

  const out: ReturnType<typeof serializeRecord>[] = [];
  let nextId = 1;
  for (const { pool, copies } of rows) {
    for (let c = 0; c < copies; c++) {
      out.push(serializeRecord(pool, params.data.id, nextId++));
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

export default router;
