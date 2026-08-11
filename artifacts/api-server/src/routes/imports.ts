import { randomUUID } from "node:crypto";
import { Router, type IRouter, type RequestHandler } from "express";
import multer from "multer";
import { requireAuth } from "./auth";
import { desc, eq, lt, inArray, sql, and, isNull, or } from "drizzle-orm";
import {
  db,
  importsTable,
  recordPoolTable,
  importRowsTable,
  uploadStagingTable,
  orderReviewImportsTable,
  importDeletionLogTable,
  settingsTable,
  contractorCategoriesTable,
  contractorAliasesTable,
  contractorDedupProposalsTable,
  rsjThicknessTable,
  manualThicknessTable,
  inventoryMfcBatchColorTable,
  itemMasterTable,
  SETTINGS_SINGLETON_ID,
  type InsertRecordPool,
  type ChangeSummary,
  type RecordPoolRow,
  type AliasEntry,
} from "@workspace/db";
import {
  GetImportParams,
  GetImportRecordsParams,
  GetImportChangesParams,
  GetImportMovementParams,
  GetImportVelocityParams,
  GetImportSummaryParams,
  GetImportSummaryBody,
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
  deriveHoleOperation,
  filterRecords,
  summarizeOverview,
  lifecycleCounts,
  identityKey,
  normalizeContractorName,
  type RecordFilters,
  type VelocitySnapshot,
  type TurnaroundSettings,
  type ActivitySequence,
  type ThicknessLookups,
} from "@workspace/domain";
import { recomputeMilestones } from "../lib/milestones";
import {
  recomputeDispatch,
  ingestOrderReview,
  computeWipCoverage,
} from "../lib/dispatch";
import { recomputeContractorMovement } from "../lib/contractorMovement";
import { recomputeReleaseBalance, recomputeAssignmentBalance } from "../lib/parseWipReleaseBalance";
import { cutoffSql, loadValidFrom, importDayKey } from "../lib/cutoff";
import {
  detectFileType,
  parseOrderReview,
  detectReportAsOnDate,
  checkOrderReview,
  type OrderReviewFileType,
} from "../lib/parse-order-review";
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

// ---------------------------------------------------------------------------
// In-process membership cache. Imports are append-only and immutable, so
// the join result for a given importId never changes once written. Caching
// eliminates the expensive 189K-row record_pool scan on every /records,
// /summary, /velocity, and /movement call (especially on cold-start in prod
// where the DB buffer cache is cold and the query takes 60-90 seconds).
// Cache is keyed by importId and evicted only on explicit import deletion.
// ---------------------------------------------------------------------------
const membershipCache = new Map<
  number,
  { pool: RecordPoolRow; copies: number; irJobCardStatus: string | null; irJobCardType: string | null }[]
>();
// Same immutability guarantee: velocity states and identity signatures for a
// given import never change once the import is committed, so caching is safe.
const velocityStateCache = new Map<number, Map<string, VelocityState>>();
const identityStateCache = new Map<number, Map<string, IdentityState>>();

// Caches the fully-serialized WipRecord[] per importId so neither /records nor
// /summary has to re-run the O(57k) serializeRecord + sort loop on every request.
// Evicted alongside membershipCache — the two share the same immutability guarantee.
// Thickness lookups and MFC project dates change rarely; the evict-on-delete
// contract is the primary safety gate.
const serializedRecordsCache = new Map<number, ReturnType<typeof serializeRecord>[]>();

// Caches the full /movement response per importId. Movement for import N depends
// only on identity states of all imports ≤ N, which are immutable once committed.
// Cleared on ANY import deletion because removing a prior import changes the chain
// for every later import's movement calculation.
const movementResponseCache = new Map<number, {
  importId: number;
  hasHistory: boolean;
  items: { markId: string; jobCardNo: string | null; daysSinceLastMovement: number | null }[];
}>();

function evictMembershipCache(importId?: number) {
  if (importId === undefined) {
    membershipCache.clear();
    velocityStateCache.clear();
    identityStateCache.clear();
    serializedRecordsCache.clear();
    movementResponseCache.clear();
  } else {
    membershipCache.delete(importId);
    velocityStateCache.delete(importId);
    identityStateCache.delete(importId);
    serializedRecordsCache.delete(importId);
    // Removing any import from the history chain invalidates movement for all
    // later imports, so clear the whole response cache (it rebuilds quickly).
    movementResponseCache.clear();
  }
}

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
// When called with the top-level `db` (not inside a transaction) the result is
// served from the in-process membershipCache after the first load — the join
// is otherwise the most expensive query in the app (~90 s on cold-start in
// production). Transaction callers always bypass the cache because in-flight
// data hasn't been committed yet.
async function loadMembership(
  executor: typeof db | Tx,
  importId: number,
): Promise<{ pool: RecordPoolRow; copies: number; irJobCardStatus: string | null; irJobCardType: string | null }[]> {
  // Only cache top-level db calls, not mid-transaction reads.
  const useCache = executor === db;
  if (useCache) {
    const cached = membershipCache.get(importId);
    if (cached) return cached;
  }
  const rows = await executor
    .select({
      pool: recordPoolTable,
      copies: importRowsTable.copies,
      // Per-import snapshots. Null for imports uploaded before this column was added.
      irJobCardStatus: importRowsTable.jobCardStatus,
      irJobCardType: importRowsTable.jobCardType,
    })
    .from(importRowsTable)
    .innerJoin(recordPoolTable, eq(importRowsTable.poolId, recordPoolTable.id))
    .where(eq(importRowsTable.importId, importId));
  if (useCache) membershipCache.set(importId, rows);
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
  const cached = identityStateCache.get(importId);
  if (cached) return cached;

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
  identityStateCache.set(importId, out);
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
  clientMfcDate?: string | null,
  /** Per-import Col G snapshot from import_rows; null for pre-migration imports. */
  irJobCardStatus?: string | null,
  /** Per-import Col A snapshot from import_rows; null for pre-migration imports. */
  irJobCardType?: string | null,
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
  // Live-derived from the immutable section (mirrors thickness), so the API is
  // correct even before the boot backfill stamps the stored columns.
  const hole = deriveHoleOperation(r.section);
  return {
    id,
    importId,
    hash: r.hash,
    markId: r.markId,
    job: r.job,
    structure: r.structure,
    markTail: r.markTail,
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
    workOrderNo: r.workOrderNo ?? null,
    // MFC batch (WO Batch No.); legacy rows are null -> serialized as "Z" so
    // blanks group and sort after real batches everywhere on the client.
    mfcBatch: r.mfcBatch ?? "Z",
    ageingDays: computeAgeing(r.activity, r.assignDate, r.lastProductionDate),
    routeSteps,
    currentStepIndex,
    category: r.category,
    ntltSubtype: r.ntltSubtype,
    groupKey: r.groupKey,
    active: r.active,
    thicknessMm,
    thicknessSource,
    sectionType: hole.sectionType,
    holeOperation: hole.holeOperation,
    // Finished Goods placeholder — currently blank everywhere (nothing writes it).
    fg: r.fg ?? null,
    // Initial Cutting exclusion: true when Col G (Job Card Status) = "Initial"
    // for THIS import.  Uses the per-import import_rows.job_card_status when
    // available (all new uploads after the migration), falling back to the
    // pool-level is_initial_cutting for pre-migration imports where the column
    // was not yet stored per-row.  This prevents a later upload from retroactively
    // changing the classification of an earlier import's view.
    isInitialCutting:
      irJobCardStatus != null
        ? irJobCardStatus.trim().toUpperCase() === "INITIAL"
        : (r.isInitialCutting ?? false),
    // Type (Col A) — "Job Card Not Started" | "Job Card WIP" |
    // "FG Pending For Dispatch" | null (old-format files).  Prefer the per-import
    // value; fall back to pool for pre-migration rows.
    jobCardType: (irJobCardType !== undefined ? irJobCardType : r.jobCardType) ?? null,
    // Date of Client MFC for this mark's project (YYYY-MM-DD). When set, the
    // TAT page uses today−clientMfcDate as the ageing baseline instead of the
    // per-mark lastProductionDate ageing. Null when no date has been entered in
    // Bucket List Dates for this project. Does not affect velocity/Speed of
    // Execution — pace is still derived from real WIP snapshot history only.
    clientMfcDate: clientMfcDate ?? null,
  };
}

// ---------------------------------------------------------------------------
// Per-(project, mfcBatch) Client MFC Date map. Sourced from
// inventory_mfc_batch_color — the same table the Bucket List Dates UI writes to.
// Key is "${project}|${mfcBatch}" (mfcBatch defaults to "Z" for legacy rows).
// Used to override the ageing baseline on the TAT page (today − clientMfcDate).
// Does not affect velocity / Speed of Execution. Upload-independent; cheap.
// ---------------------------------------------------------------------------
async function loadProjectDates(): Promise<Map<string, string>> {
  const rows = await db.select().from(inventoryMfcBatchColorTable);
  const map = new Map<string, string>();
  for (const r of rows) {
    if (r.dateOfClientMfc) map.set(`${r.project}|${r.mfcBatch ?? "Z"}`, r.dateOfClientMfc);
  }
  return map;
}

// Load the two thickness config maps (RSJ lookup by group key + manual pins by
// mark_id) so records can be resolved live, exactly like ageing. Read-only.
// In-process cache for thickness lookups. RSJ/manual thickness tables change
// rarely (only when an admin pins a thickness). Caching eliminates two DB
// round-trips on every /records and /summary request. Invalidated by calling
// clearThicknessCache(), which thickness.ts calls after any PUT/DELETE.
let _thicknessCache: ThicknessLookups | null = null;

export function clearThicknessCache(): void {
  _thicknessCache = null;
}

/** Evict the serialised records cache for one import (or all if importId omitted).
 *  Call after any operation that changes how records resolve (thickness pins, etc.)
 *  so the next /records fetch rebuilds from scratch with the updated lookups. */
export function evictSerializedRecordsCache(importId?: number): void {
  if (importId === undefined) {
    serializedRecordsCache.clear();
  } else {
    serializedRecordsCache.delete(importId);
  }
}

export async function loadThicknessLookups(): Promise<ThicknessLookups> {
  if (_thicknessCache) return _thicknessCache;
  const [rsjRows, manualRows, masterRows] = await Promise.all([
    db.select().from(rsjThicknessTable),
    db.select().from(manualThicknessTable),
    // Only rows that have a positive thickness and are not JW items and are not
    // from the FG JOB WORK group (which would collide with RSJ POLE entries
    // after stripping). The SQL filter mirrors the same exclusions applied when
    // building lookup maps at load time.
    db
      .select({
        itemName: itemMasterTable.itemName,
        groupName: itemMasterTable.groupName,
        thicknessMm: itemMasterTable.thicknessMm,
        exactKey: itemMasterTable.exactKey,
        strippedKey: itemMasterTable.strippedKey,
      })
      .from(itemMasterTable)
      .where(
        sql`${itemMasterTable.thicknessMm} is not null
          and ${itemMasterTable.thicknessMm} > 0
          and ${itemMasterTable.itemName} not ilike '%(JW)%'
          and coalesce(${itemMasterTable.groupName}, '') <> 'FG JOB WORK'`,
      ),
  ]);

  // Build RSJ lookup maps from the admin table.
  const rsjByKey = new Map(rsjRows.map((r) => [r.groupKey, r.thicknessMm]));

  // Build item-master exact map: exactKey -> thickness.
  // When two rows share the same exactKey but have different thicknesses the key
  // is ambiguous — omit it from the map (fall through to section parse / RSJ chain).
  const masterExactMap = new Map<string, number>();
  const exactConflict = new Set<string>();
  for (const r of masterRows) {
    if (!r.thicknessMm) continue;
    const key = r.exactKey;
    if (exactConflict.has(key)) continue;
    if (masterExactMap.has(key)) {
      if (masterExactMap.get(key) !== r.thicknessMm) {
        masterExactMap.delete(key);
        exactConflict.add(key);
      }
    } else {
      masterExactMap.set(key, r.thicknessMm);
    }
  }

  // Build item-master stripped map: strippedKey -> thickness.
  // Same conflict guard — omit ambiguous stripped keys rather than guessing.
  const masterStrippedMap = new Map<string, number>();
  const strippedConflict = new Set<string>();
  for (const r of masterRows) {
    if (!r.thicknessMm || !r.strippedKey) continue;
    const key = r.strippedKey;
    if (strippedConflict.has(key)) continue;
    if (masterStrippedMap.has(key)) {
      if (masterStrippedMap.get(key) !== r.thicknessMm) {
        masterStrippedMap.delete(key);
        strippedConflict.add(key);
      }
    } else {
      masterStrippedMap.set(key, r.thicknessMm);
    }
  }

  // Build RSJ base index from the combined pool: master RSJ entries give us
  // coverage beyond the 6-entry admin table, while admin entries fill any gaps
  // the master doesn't cover. Feed both sets into buildRsjBaseIndex.
  const rsjByKeyCombined = new Map<string, number>(rsjByKey);
  for (const [k, v] of masterExactMap) {
    if (k.startsWith("RSJ ") && !rsjByKeyCombined.has(k)) {
      rsjByKeyCombined.set(k, v);
    }
  }
  const { rsjBaseByKey, ambiguousRsjBases } =
    buildRsjBaseIndex(rsjByKeyCombined);

  _thicknessCache = {
    rsjByKey,
    manualByMarkId: new Map(manualRows.map((r) => [r.markId, r.thicknessMm])),
    rsjBaseByKey,
    ambiguousRsjBases,
    masterExactMap,
    masterStrippedMap,
  };
  return _thicknessCache;
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
  meta: {
    label: string | null;
    reportDate: string | null;
    asOnDate: string | null;
    sourceFilename: string;
  },
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

    // Previous import = the most recent existing import (append-only ledger),
    // bounded to the global WIP cutoff so the change log a new upload produces
    // compares against the previous IN-WINDOW import (pre-cutoff imports are
    // ignored as if never uploaded). cutoffSql(null) is a no-op.
    const cutoff = await loadValidFrom();
    const [prevImport] = await tx
      .select()
      .from(importsTable)
      .where(cutoffSql(cutoff))
      .orderBy(sql`${importsTable.reportDate} DESC NULLS LAST`, desc(importsTable.id))
      .limit(1);

    const [imp] = await tx
      .insert(importsTable)
      .values({
        label: meta.label,
        sourceFilename: meta.sourceFilename,
        reportDate: meta.reportDate,
        asOnDate: meta.asOnDate,
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
      toInsert.push(row as InsertRecordPool);
    }
    const chunk = 500;
    for (let i = 0; i < toInsert.length; i += chunk) {
      // onConflictDoUpdate instead of onConflictDoNothing: updates the derived
      // is_initial_cutting flag on re-upload so a parse-logic fix propagates to
      // records that were first inserted with a stale value. Identity columns
      // (hash, qty, wt, dates, mark fields) are never touched — only the
      // non-hashed exclusion flag is refreshed. The RETURNING clause now covers
      // both new inserts AND updated-on-conflict rows, so the secondary SELECT
      // below only needs to catch any truly unresolved hashes.
      const inserted = await tx
        .insert(recordPoolTable)
        .values(toInsert.slice(i, i + chunk))
        .onConflictDoUpdate({
          target: recordPoolTable.hash,
          set: {
            isInitialCutting: sql`EXCLUDED.is_initial_cutting`,
            // Refresh non-hashed derived columns so a re-upload of a new-format file
            // (which has Col A "Type" and Col G "Status") stamps existing pool rows
            // that were first inserted from an older format without these columns.
            jobCardType: sql`COALESCE(EXCLUDED.job_card_type, record_pool.job_card_type)`,
            jobCardStatus: sql`COALESCE(EXCLUDED.job_card_status, record_pool.job_card_status)`,
          },
        })
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
    // job_card_status and job_card_type are stored per-import so that a later
    // upload's onConflictDoUpdate cannot retroactively change the classification
    // of an earlier import's view.
    const memberships = Array.from(multiset.entries()).map(
      ([hash, { count, row }]) => ({
        importId: imp.id,
        poolId: poolIdByHash.get(hash)!,
        copies: count,
        jobCardStatus: (row as InsertRecordPool).jobCardStatus ?? null,
        jobCardType: (row as InsertRecordPool).jobCardType ?? null,
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

router.get("/imports", async (req, res): Promise<void> => {
  // The app-wide list is scoped to the global WIP cutoff so every consumer
  // (header selector, changes panel, store selection) agrees on the active
  // window. `?all=true` bypasses the cutoff for the admin cutoff picker, which
  // must offer every upload date. cutoffSql(null) is a no-op (byte-identical).
  const all = req.query.all === "true" || req.query.all === "1";
  const cutoff = all ? null : await loadValidFrom();
  const rows = await db
    .select()
    .from(importsTable)
    .where(cutoffSql(cutoff))
    .orderBy(desc(importsTable.createdAt));

  // Determine which imports have per-row type data stored in import_rows.
  // Old-format imports (ingested before job_card_type was written) have 100%
  // NULL job_card_type in import_rows; their bucket figures are fabricated via
  // COALESCE from the pool and must never be presented as real classification.
  const withTypeRows = await db
    .selectDistinct({ importId: importRowsTable.importId })
    .from(importRowsTable)
    .where(sql`${importRowsTable.jobCardType} IS NOT NULL`);
  const hasTypeSet = new Set(withTypeRows.map((r) => r.importId));

  const result = rows.map((r) => ({ ...r, hasTypeData: hasTypeSet.has(r.id) }));
  res.json(result);
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
  // Pairing date for the Order Review gate: the report's own "As on" banner date or
  // the date encoded in its filename, falling back to today (the upload date) when
  // neither is present/parseable.
  const asOnDate =
    detectReportAsOnDate(file.buffer, file.originalname) ?? todayYmd();

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
    { label, reportDate, asOnDate, sourceFilename: file.originalname },
    req.log,
  );

  // Refresh permanent project milestones (capture-once; best-effort).
  try {
    await recomputeMilestones();
  } catch (err) {
    req.log.warn({ err }, "Milestone recompute failed after import");
  }
  // Refresh computed dispatch (Yard departures; best-effort).
  try {
    await recomputeDispatch();
  } catch (err) {
    req.log.warn({ err }, "Dispatch recompute failed after import");
  }
  // Refresh contractor movement ledger (best-effort).
  try {
    await recomputeContractorMovement();
  } catch (err) {
    req.log.warn({ err }, "Contractor movement recompute failed after import");
  }
  // Refresh Release Balance Computed snapshot (Not Started + Initial rows; best-effort).
  // Scoped to this import only — never touches other imports' rows.
  try {
    await recomputeReleaseBalance(file.buffer, result.import.id);
  } catch (err) {
    req.log.warn({ err, importId: result.import.id }, "Release balance recompute failed after import");
  }
  // Refresh Assignment Balance snapshot (Not Started + blank contractor; best-effort).
  // Runs after Release Balance so both snapshots are consistent for this import.
  try {
    await recomputeAssignmentBalance(file.buffer);
  } catch (err) {
    req.log.warn({ err }, "Assignment balance recompute failed after import");
  }
  // Flag any contractor strings from the new import that are not yet classified
  // in contractor_categories or covered by an alias/proposal. Each new string
  // becomes a pending contractor_dedup_proposals row for admin review.
  try {
    await flagNewContractors(result.import.id, req.log);
  } catch (err) {
    req.log.warn({ err }, "Contractor flagging failed after import (non-fatal)");
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

// Read the optional per-slot expected type from a request body. Each upload slot
// (WIP vs Order Review) tells the validator/commit which type it expects so a
// mis-routed file is caught — auto-detect stays a secondary safety net.
function readExpectedType(body: unknown): OrderReviewFileType | null {
  const v = (body as { expectedType?: unknown })?.expectedType;
  return v === "wip" || v === "order-review" ? v : null;
}

const SLOT_LABEL: Record<"wip" | "order-review", string> = {
  wip: "WIP / Balance & Activity",
  "order-review": "Order Review",
};

// A consistent, helpful message when a file does not match its upload slot's
// expected type. When the file clearly matches the OTHER known type we point the
// user at the correct slot; otherwise we report it is neither known type.
function typeMismatchMessage(detected: OrderReviewFileType): string {
  if (detected === "wip" || detected === "order-review") {
    return `This looks like a ${SLOT_LABEL[detected]} file — please use the ${SLOT_LABEL[detected]} uploader.`;
  }
  return "This doesn't look like a valid WIP or Order Review file.";
}

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

  const fileType = detectFileType(file.buffer);

  // Order Review (the second input file) gets a deterministic structural read of
  // its own; it never goes through the WIP structural reader / AI gatekeeper.
  if (fileType === "order-review") {
    let orderReview;
    let sanityCheck = null;
    try {
      orderReview = parseOrderReview(file.buffer);
      const coverage = await computeWipCoverage(orderReview.rows);
      orderReview = {
        ...orderReview,
        summary: { ...orderReview.summary, ...coverage },
      };
      // Query the latest committed Order Review import for prev-date and prev
      // unmatched count — used by the stale-date and unmatched-spike checks.
      // Sort by as_on_date DESC (not id DESC) so the "current" OR matches what
      // loadLatestOrderReview uses — a bulk upload can assign higher ids to
      // older-dated files, making id order ≠ date order.
      const prevOrRows = await db
        .select({
          asOnDate: orderReviewImportsTable.asOnDate,
          summary: orderReviewImportsTable.summary,
        })
        .from(orderReviewImportsTable)
        .orderBy(sql`${orderReviewImportsTable.asOnDate} DESC NULLS LAST`, desc(orderReviewImportsTable.id))
        .limit(1);
      const prevOr = prevOrRows[0] ?? null;
      const prevSummary = prevOr?.summary as { unmatchedToWip?: number } | null;
      sanityCheck = checkOrderReview(file.buffer, orderReview, {
        prevSummary,
        prevAsOnDate: prevOr?.asOnDate ?? null,
      });
    } catch (err) {
      req.log.warn({ err }, "Order Review parse failed for staged upload");
      orderReview = { asOnDate: null, rows: [], summary: null };
    }
    res.status(201).json({
      stagingId,
      sourceFilename: file.originalname,
      fileType,
      orderReview: {
        // Surface the robust pairing date (banner OR filename) so the uploader can
        // pre-check per-date pairing; falls back to the parser's banner-only value.
        asOnDate:
          detectReportAsOnDate(file.buffer, file.originalname) ??
          orderReview.asOnDate,
        summary: orderReview.summary,
        sanityCheck,
      },
      structural: null,
    });
    return;
  }

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
      wipFormatCheck: null,
    };
  }

  res.status(201).json({
    stagingId,
    sourceFilename: file.originalname,
    fileType,
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

  // Order Review files are validated deterministically (no AI gatekeeper): a
  // parseable file with at least one (project, structure) row is accepted.
  const fileType = detectFileType(staged.fileData);

  // Type-matched validation: the slot tells us which type to EXPECT. If the file
  // does not match, reject with a helpful cross-type message before any further
  // checks. Auto-detect (fileType) is the secondary safety net behind the slot.
  const expectedType = readExpectedType(req.body);
  if (expectedType && fileType !== expectedType) {
    res.json({
      available: false,
      fileType,
      verdict: "reject",
      reason: typeMismatchMessage(fileType),
      expectedShape:
        expectedType === "wip"
          ? "A WIP balance/activity .xlsx with Project Code + Mark No. + Activity."
          : "An Order Review .xlsx with Tower Type Code + Despatch MT.",
      sanitize: [],
    });
    return;
  }

  if (fileType === "order-review") {
    let parsedOr;
    try {
      parsedOr = parseOrderReview(staged.fileData);
    } catch {
      parsedOr = null;
    }
    const ok = !!parsedOr && parsedOr.rows.length > 0;
    if (!ok) {
      res.json({
        available: false,
        fileType,
        verdict: "reject",
        reason:
          "No order rows found. Expected a per-structure Order Review export with Tower Type Code and Despatch MT columns.",
        expectedShape:
          "An .xlsx Order Review export: a 'Project Code : NNN' banner with rows carrying Tower Type Code, Weight MT, and Despatch MT.",
        sanitize: [],
        aiAdvisory: null,
      });
      return;
    }

    // AI advisory (Part 3): when a key is configured, pass a compact summary of
    // the file + the sanity-check findings to Claude for a plain-language review.
    let aiAdvisory: string | null = null;
    if (isAiAvailable() && parsedOr) {
      try {
        const s = parsedOr.summary;
        // Re-run the sanity check so the AI sees the same flags the user sees.
        const sc = checkOrderReview(staged.fileData, parsedOr);
        const compactSummary = {
          rowsRead: s.rowsRead,
          rowsKept: s.rowsKept,
          projects: s.projectsFound,
          totalWeightMt: s.totalWeightMt,
          totalReleaseMt: s.totalReleaseMt,
          totalDespatchMt: s.totalFileDespatchMt,
          matchedToWip: s.matchedToWip,
          unmatchedToWip: s.unmatchedToWip,
          missingStructure: s.missingStructure,
          formatOk: sc.formatCheck.ok,
          missingColumns: sc.formatCheck.missingExpected,
          criticalMissing: sc.formatCheck.criticalMissing,
          renames: sc.formatCheck.renames,
          dataFlags: sc.dataFlags,
        };
        const system =
          "You are a concise data quality reviewer for a steel-fabrication Order Review file. " +
          "The deterministic engine has already run format and data sanity checks. " +
          "Your role is ADVISORY ONLY — you synthesize the findings into a short, plain-language assessment " +
          "that helps the operator decide whether to import. " +
          "Produce 3-6 sentences maximum. Focus on the most important risks. " +
          "Do NOT restate numbers verbatim — describe what they imply. " +
          "Do NOT approve or reject the import — the user always decides. " +
          "Do NOT use markdown, bullet points, or headers — plain prose only.";
        const user =
          "Order Review file summary and sanity-check findings:\n" +
          JSON.stringify(compactSummary, null, 2);
        const result = await callClaude({
          model: AI_MODEL_STANDARD,
          system,
          user,
          maxTokens: 512,
        });
        if (result.ok) {
          aiAdvisory = result.text.trim();
        } else {
          req.log.warn({ stagingId }, "OR AI advisory call failed");
        }
      } catch (err) {
        req.log.warn({ err, stagingId }, "OR AI advisory threw unexpectedly");
      }
    }

    res.json({
      available: isAiAvailable(),
      fileType,
      verdict: "ok",
      reason: null,
      expectedShape:
        "An .xlsx Order Review export: a 'Project Code : NNN' banner with rows carrying Tower Type Code, Weight MT, and Despatch MT.",
      sanitize: [],
      aiAdvisory,
    });
    return;
  }
  if (fileType === "unknown") {
    res.json({
      available: false,
      fileType,
      verdict: "reject",
      reason:
        "Unrecognised file. Upload either a WIP balance/activity report (Project Code + Mark No. + Activity) or an Order Review export.",
      expectedShape:
        "A WIP balance/activity .xlsx, or an Order Review .xlsx with Tower Type Code + Despatch MT.",
      sanitize: [],
    });
    return;
  }

  if (!isAiAvailable()) {
    res.json({ ...unavailable, fileType });
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

  // Type-matched commit (defense in depth): when the slot declares an expected
  // type, a file whose detected type differs must NOT commit, even if a caller
  // posts straight to commit bypassing the UI gate and /validate.
  const detected = detectFileType(staged.fileData);
  const expectedType = readExpectedType(req.body);
  if (expectedType && detected !== expectedType) {
    res.status(400).json({ error: typeMismatchMessage(detected) });
    return;
  }

  // Reject unrecognised files explicitly (defense in depth: a caller may post
  // straight to commit, bypassing /validate). Only WIP and Order Review commit.
  if (detected === "unknown") {
    res.status(400).json({
      error:
        "Unrecognised file. Upload either a WIP balance/activity report (Project Code + Mark No. + Activity) or an Order Review export.",
    });
    return;
  }

  // Order Review files commit via a separate, deterministic ingest path: create
  // an order_review_imports row, capture-once seed dispatch, recompute. Idempotent
  // via committed_order_review_import_id (a retried commit returns the same one).
  if (detected === "order-review") {
    if (staged.committedOrderReviewImportId != null) {
      const [imp] = await db
        .select()
        .from(orderReviewImportsTable)
        .where(eq(orderReviewImportsTable.id, staged.committedOrderReviewImportId));
      if (imp) {
        res
          .status(200)
          .json({ kind: "order-review", orderReviewImport: imp, seeded: 0 });
        return;
      }
    }

    // Strict per-date pairing: an Order Review may only be committed for a date
    // that already has a committed WIP / Balance & Activity import. The pairing key
    // is the user-selected date (staged.reportDate) OR the "As on" banner/filename
    // date. The user-selected date takes priority.
    const orderAsOnDate =
      staged.reportDate ??
      detectReportAsOnDate(staged.fileData, staged.sourceFilename);
    if (!orderAsOnDate) {
      res.status(400).json({
        error:
          "Could not read the Order Review's 'As on' date, so it can't be matched to a WIP report.",
      });
      return;
    }
    const [wipMatch] = await db
      .select({ id: importsTable.id })
      .from(importsTable)
      .where(eq(importsTable.asOnDate, orderAsOnDate))
      .limit(1);
    if (!wipMatch) {
      res.status(409).json({
        error: `Upload and accept the WIP / Balance & Activity report for ${orderAsOnDate} before its Order Review.`,
      });
      return;
    }
    // Uniqueness: only one Order Review per date.
    const [existingOr] = await db
      .select({ id: orderReviewImportsTable.id })
      .from(orderReviewImportsTable)
      .where(eq(orderReviewImportsTable.asOnDate, orderAsOnDate))
      .limit(1);
    if (existingOr) {
      res.status(409).json({
        error: `An Order Review for ${orderAsOnDate} already exists. Delete it first before uploading a new one.`,
      });
      return;
    }
    // Stale-date guard: refuse if the file's as-on date is older than the newest
    // already-ingested Order Review, unless the caller explicitly overrides.
    // The guard protects against a bulk upload silently reverting the order book
    // to an older snapshot (as happened with the 10-Aug bulk upload that left
    // the 28-Jul OR as the newest by id even though 10-Aug was already stored).
    const forceStaleDate = req.body?.forceStaleDate === true;
    if (!forceStaleDate) {
      const [newestOr] = await db
        .select({ asOnDate: orderReviewImportsTable.asOnDate })
        .from(orderReviewImportsTable)
        .orderBy(sql`${orderReviewImportsTable.asOnDate} DESC NULLS LAST`, desc(orderReviewImportsTable.id))
        .limit(1);
      const newestDate = newestOr?.asOnDate ?? null;
      if (newestDate && orderAsOnDate < newestDate) {
        res.status(409).json({
          error: `This file's date (${orderAsOnDate}) is older than the current Order Review (${newestDate}). Uploading would revert the order book to an earlier snapshot.`,
          staleDateWarning: true,
          fileAsOnDate: orderAsOnDate,
          existingAsOnDate: newestDate,
        });
        return;
      }
    }

    // Serialize the whole Order Review commit under the shared dispatch advisory
    // lock (the same one WIP merges take). The ingest now UPSERTS shared current
    // rows in place, so two concurrent commits of the same staged file must NOT
    // interleave — that would create duplicate imports and leave rows pointing at
    // a dropped import (wrongly flagged "not in latest"). Holding the lock for
    // this transaction's lifetime forces concurrent commits to wait, then observe
    // the idempotency guard already set and replay the winner without re-ingesting.
    let outcome: {
      importRow: typeof orderReviewImportsTable.$inferSelect;
      seeded: number;
      created: boolean;
    };
    try {
      outcome = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(728041)`);
        // Re-check the idempotency guard under the lock: a concurrent commit may
        // have ingested this exact staged file while we were waiting.
        const [fresh] = await tx
          .select({
            committedOrderReviewImportId:
              uploadStagingTable.committedOrderReviewImportId,
          })
          .from(uploadStagingTable)
          .where(eq(uploadStagingTable.id, stagingId));
        const winnerId = fresh?.committedOrderReviewImportId ?? null;
        if (winnerId != null) {
          const [winner] = await tx
            .select()
            .from(orderReviewImportsTable)
            .where(eq(orderReviewImportsTable.id, winnerId));
          if (winner) return { importRow: winner, seeded: 0, created: false };
        }
        // We hold the lock and the file is unclaimed: this transaction owns the
        // ingest. ingestOrderReview runs its own writes via the pool, serialized
        // by the lock we hold here.
        const ingest = await ingestOrderReview(staged.fileData, {
          sourceFilename: staged.sourceFilename,
          label: staged.label,
          asOnDate: orderAsOnDate,
        });
        await tx
          .update(uploadStagingTable)
          .set({ committedOrderReviewImportId: ingest.importId })
          .where(eq(uploadStagingTable.id, stagingId));
        const [imp] = await tx
          .select()
          .from(orderReviewImportsTable)
          .where(eq(orderReviewImportsTable.id, ingest.importId));
        return { importRow: imp, seeded: ingest.seeded, created: true };
      });
    } catch (err) {
      req.log.warn({ err, stagingId }, "Order Review ingest failed");
      res.status(400).json({ error: "Could not ingest the Order Review file" });
      return;
    }

    res.status(outcome.created ? 201 : 200).json({
      kind: "order-review",
      orderReviewImport: outcome.importRow,
      seeded: outcome.seeded,
    });
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
      res
        .status(200)
        .json({ kind: "wip", import: imp, changeSet: changeSetFromImport(imp) });
      return;
    }
    // The committed import was later deleted; fall through and re-commit.
  }

  // Resolve the "as on" date for this WIP file: prefer the user-selected date
  // (stored as staged.reportDate when the file was staged), then the banner/
  // filename auto-detect, then today as last resort.
  const wipAsOnDate =
    staged.reportDate ??
    detectReportAsOnDate(staged.fileData, staged.sourceFilename) ??
    todayYmd();

  // Uniqueness: only one WIP per date. The uniqueness key is asOnDate so it
  // aligns with the Order Review pairing gate.
  const [existingWip] = await db
    .select({ id: importsTable.id })
    .from(importsTable)
    .where(eq(importsTable.asOnDate, wipAsOnDate))
    .limit(1);
  if (existingWip) {
    res.status(409).json({
      error: `A WIP report for ${wipAsOnDate} already exists. Delete it first before uploading a new one for this date.`,
    });
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
      asOnDate: wipAsOnDate,
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
        .json({ kind: "wip", import: winner, changeSet: changeSetFromImport(winner) });
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
  // Refresh computed dispatch (Yard departures; best-effort).
  try {
    await recomputeDispatch();
  } catch (err) {
    req.log.warn({ err }, "Dispatch recompute failed after commit");
  }
  // Refresh contractor movement ledger (best-effort).
  try {
    await recomputeContractorMovement();
  } catch (err) {
    req.log.warn({ err }, "Contractor movement recompute failed after commit");
  }
  // Refresh Release Balance Computed snapshot (Not Started + Initial rows; best-effort).
  // Scoped to this import only — never touches other imports' rows.
  try {
    await recomputeReleaseBalance(staged.fileData, result.import.id);
  } catch (err) {
    req.log.warn({ err, importId: result.import.id }, "Release balance recompute failed after commit");
  }
  // Refresh Assignment Balance snapshot (Not Started + blank contractor; best-effort).
  try {
    await recomputeAssignmentBalance(staged.fileData);
  } catch (err) {
    req.log.warn({ err }, "Assignment balance recompute failed after commit");
  }
  res.status(201).json({ kind: "wip", ...result });
});

// DELETE /imports/stage/:id — discard a staged upload without committing.
router.delete("/imports/stage/:id", requireAuth, async (req, res): Promise<void> => {
  const id = String(req.params.id);
  await db.delete(uploadStagingTable).where(eq(uploadStagingTable.id, id));
  res.status(204).end();
});

// GET /imports/deletion-log — returns all import deletion audit log entries,
// newest first. Admin-only context: the frontend shows this on the Data page.
router.get("/imports/deletion-log", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(importDeletionLogTable)
    .orderBy(desc(importDeletionLogTable.deletedAt));
  res.json(rows);
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

  // Enforce the global WIP cutoff server-side: a pre-cutoff import is treated as
  // if it were never uploaded, so it cannot be one side of a comparison. The
  // client selector already only offers in-window ids, so this never rejects a
  // legitimate request; it just makes the server authoritative. cutoff === null
  // (the default) skips the check entirely, so behaviour is byte-identical.
  const compareCutoff = await loadValidFrom();
  if (compareCutoff !== null) {
    const outOfWindow =
      importDayKey(toImport.reportDate, toImport.createdAt) < compareCutoff ||
      importDayKey(fromImport.reportDate, fromImport.createdAt) < compareCutoff;
    if (outOfWindow) {
      res.status(404).json({ error: "Import is outside the active window" });
      return;
    }
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

// GET /imports/:id/new-projects — project codes that appear in this import but
// were NEVER present in any BASELINE-PERIOD WIP import.
//
// Rule: a project present during the baseline period has history the app never
// captured (it existed in the ERP before capture stabilised), so its
// reconstructed chain is incomplete. A project that arrived later has been
// tracked from day one and is eligible for the Generated OR view.
//
// The baseline period covers every import up to and including the 04-Jul-2026
// baseline WIP file — NOT just the single earliest import. The first uploads
// (27–30 Jun 2026) were partial captures while intake stabilised; projects that
// "appeared" during that window (e.g. 848, 893, 932, 936, 947, 952) actually
// pre-existed in the ERP and reconstruct incompletely. Verified against real
// data: every genuinely-new project first appears on 05-Jul-2026 or later.
// Falls back to MIN(import_id) when no import matches the baseline window
// (e.g. a fresh database seeded only with post-baseline files).
//
// The qualifying set is stable: it can only grow (new projects arrive in later
// WIP files) and never shrinks.
router.get("/imports/:id/new-projects", async (req, res): Promise<void> => {
  const params = GetImportParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const rows = await db.execute<{ job: string }>(sql`
    WITH baseline_cutoff AS (
      -- Latest import in the baseline window (report date, else UTC upload day,
      -- on/before 04-Jul-2026); fall back to the earliest import ever loaded.
      SELECT COALESCE(
        (SELECT MAX(i.id) FROM imports i
         WHERE COALESCE(i.report_date, (i.created_at AT TIME ZONE 'UTC')::date)
               <= DATE '2026-07-04'),
        (SELECT MIN(import_id) FROM import_rows)
      ) AS max_id
    ),
    baseline_projects AS (
      SELECT DISTINCT rp.job
      FROM import_rows ir
      JOIN record_pool rp ON rp.id = ir.pool_id
      WHERE ir.import_id <= (SELECT max_id FROM baseline_cutoff)
        AND rp.job IS NOT NULL
        AND rp.job <> ''
        AND rp.job <> '(Unassigned)'
    )
    SELECT DISTINCT rp.job
    FROM import_rows ir
    JOIN record_pool rp ON rp.id = ir.pool_id
    WHERE ir.import_id = ${params.data.id}
      AND rp.job IS NOT NULL
      AND rp.job <> ''
      AND rp.job <> '(Unassigned)'
      AND rp.job NOT IN (SELECT job FROM baseline_projects)
  `);
  res.json({ codes: (rows.rows ?? rows as unknown as { job: string }[]).map((r) => r.job) });
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

  evictMembershipCache();
  req.log.info(result, "deleted all imports and record pool");
  res.json(result);
});

router.delete("/imports/:id", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteImportParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  // Fetch metadata before deleting so we can write the deletion log.
  const [target] = await db
    .select({
      id: importsTable.id,
      sourceFilename: importsTable.sourceFilename,
      asOnDate: importsTable.asOnDate,
    })
    .from(importsTable)
    .where(eq(importsTable.id, params.data.id));

  if (!target) {
    res.status(404).json({ error: "Import not found" });
    return;
  }

  // Write audit log entry before deletion (if the delete fails, the log entry
  // is harmless; if the log write fails, the delete still proceeds).
  try {
    const actor = req.user?.displayName || req.user?.email || "unknown";
    await db.insert(importDeletionLogTable).values({
      importId: target.id,
      fileType: "wip",
      sourceFilename: target.sourceFilename,
      reportDate: target.asOnDate ?? null,
      deletedBy: actor,
    });
  } catch (err) {
    req.log.warn({ err, importId: target.id }, "Could not write deletion log");
  }

  const [deleted] = await db
    .delete(importsTable)
    .where(eq(importsTable.id, params.data.id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Import not found" });
    return;
  }

  evictMembershipCache(params.data.id);

  // Refresh permanent project milestones so last-seen / dispatch state stays
  // consistent after the deletion (best-effort; never fails the request).
  try {
    await recomputeMilestones();
  } catch (err) {
    req.log.warn({ err }, "Milestone recompute failed after import delete");
  }
  // Refresh computed dispatch after the deletion (best-effort).
  try {
    await recomputeDispatch();
  } catch (err) {
    req.log.warn({ err }, "Dispatch recompute failed after import delete");
  }
  // Refresh contractor movement ledger after the deletion (best-effort).
  try {
    await recomputeContractorMovement();
  } catch (err) {
    req.log.warn({ err }, "Contractor movement recompute failed after import delete");
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

  // Serve from cache if available — avoids the O(57k) serialize+sort on hot paths.
  const cachedRecords = serializedRecordsCache.get(params.data.id);
  if (cachedRecords) {
    res.json(cachedRecords);
    return;
  }

  // Fire all three reads in parallel — independent data sources.
  const [rows, thicknessLookups, projectDates] = await Promise.all([
    loadMembership(db, params.data.id),
    loadThicknessLookups(),
    loadProjectDates(),
  ]);
  rows.sort((a, b) => a.pool.markId.localeCompare(b.pool.markId));

  const out: ReturnType<typeof serializeRecord>[] = [];
  let nextId = 1;
  for (const { pool, copies, irJobCardStatus, irJobCardType } of rows) {
    const clientMfcDate = projectDates.get(`${pool.job}|${pool.mfcBatch ?? "Z"}`) ?? null;
    for (let c = 0; c < copies; c++) {
      out.push(serializeRecord(pool, params.data.id, nextId++, thicknessLookups, clientMfcDate, irJobCardStatus, irJobCardType));
    }
  }
  serializedRecordsCache.set(params.data.id, out);

  res.json(out);
});

// Server-side Overview summary. Computes every headline metric the Overview page
// renders from the import's records with the supplied filter set + resolved date
// window applied, so the client never has to download the full ~40 MB records
// payload just to render the dashboard. Filtering + aggregation run the SAME
// shared @workspace/domain code the client uses, so the numbers are identical by
// construction. Purely additive and read-only.
router.post("/imports/:id/summary", async (req, res): Promise<void> => {
  const params = GetImportSummaryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = GetImportSummaryBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
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

  // Reuse the serialized records array from cache (populated by /records) to
  // avoid a redundant O(57 k) serialize+sort when the Overview dashboard loads
  // summary and records in parallel on the same import.
  let serialized = serializedRecordsCache.get(params.data.id);
  if (!serialized) {
    // Serialize the full record set EXACTLY as /records does, then apply the same
    // shared filter + aggregators the client uses (byte-identical by construction).
    // Fire all three reads in parallel — independent data sources.
    const [rows, thicknessLookups, projectDatesForSummary] = await Promise.all([
      loadMembership(db, params.data.id),
      loadThicknessLookups(),
      loadProjectDates(),
    ]);
    rows.sort((a, b) => a.pool.markId.localeCompare(b.pool.markId));
    serialized = [];
    let nextId = 1;
    for (const { pool, copies, irJobCardStatus, irJobCardType } of rows) {
      const clientMfcDate = projectDatesForSummary.get(`${pool.job}|${pool.mfcBatch ?? "Z"}`) ?? null;
      for (let c = 0; c < copies; c++) {
        serialized.push(serializeRecord(pool, params.data.id, nextId++, thicknessLookups, clientMfcDate, irJobCardStatus, irJobCardType));
      }
    }
    serializedRecordsCache.set(params.data.id, serialized);
  }

  // Contractor sub-category overlay (normalized name -> category + tags), matching
  // the client's useContractorCategoryMap. Only consulted when those filters are
  // active, but always cheap to build.
  const catRows = await db.select().from(contractorCategoriesTable);
  const categoryMap = new Map<string, { category: string; outVendorType: string[] }>();
  for (const row of catRows) {
    categoryMap.set(row.nameKey, {
      category: row.category,
      outVendorType: row.outVendorType ?? [],
    });
  }

  // Contractor alias map (aliasKey -> canonicalKey), matching the client's
  // useContractorAliasMap so the shared filterRecords contractor match stays
  // byte-identical on both sides (alias-aware canonical-key comparison).
  const aliasRows = await db
    .select({
      aliasKey: contractorAliasesTable.aliasKey,
      canonicalKey: contractorAliasesTable.canonicalKey,
    })
    .from(contractorAliasesTable);
  const aliasMap = new Map<string, string>();
  for (const row of aliasRows) aliasMap.set(row.aliasKey, row.canonicalKey);

  const f = body.data.filters;
  const filters: RecordFilters = {
    category: f.category,
    ntltSubtype: f.ntltSubtype ?? null,
    job: f.job ?? null,
    jobIn: f.jobIn && f.jobIn.length > 0 ? new Set(f.jobIn) : null,
    section: f.section ?? null,
    mfcBatch: f.mfcBatch ?? null,
    structure: f.structure ?? null,
    mark: f.mark ?? null,
    contractor: f.contractor ?? null,
    contractorCategory: f.contractorCategory ?? null,
    outVendorType: f.outVendorType ?? null,
    activity: f.activity ?? null,
    holeOperation: f.holeOperation ?? null,
    search: f.search,
  };
  const dateWindow = body.data.dateWindow ?? null;

  const filtered = filterRecords(serialized, filters, { dateWindow, categoryMap, aliasMap });
  const overview = summarizeOverview(filtered);

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

  const lifecycle = lifecycleCounts(filtered, settings);

  // Velocity: intersect the engine's per-identity items with the visible
  // (filtered) identities, on the SAME identity basis as the /stuck page and the
  // Overview snapshot card, so totals can never disagree.
  const { items, hasHistory } = await computeVelocityItems(target, settings);
  const visible = new Set(filtered.map((r) => identityKey(r.markId, r.jobCardNo)));
  let stalled = 0;
  let slow = 0;
  let moving = 0;
  let insufficient = 0;
  for (const v of items) {
    if (!visible.has(identityKey(v.markId, v.jobCardNo))) continue;
    if (v.status === "stalled") stalled++;
    else if (v.status === "slow") slow++;
    else if (v.status === "moving") moving++;
    else insufficient++;
  }

  res.json({
    importId: target.id,
    ...overview,
    lifecycle,
    velocity: { stalled, slow, moving, insufficient, hasHistory },
  });
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

  // Bound the previous-import lookup to the global WIP cutoff so the change log
  // compares against the previous IN-WINDOW import. cutoffSql(null) is a no-op.
  const changesCutoff = await loadValidFrom();
  const [prevImport] = await db
    .select()
    .from(importsTable)
    .where(and(
      or(
        lt(importsTable.reportDate, toImport.reportDate),
        and(eq(importsTable.reportDate, toImport.reportDate), lt(importsTable.id, toImport.id)),
      ),
      cutoffSql(changesCutoff),
    ))
    .orderBy(sql`${importsTable.reportDate} DESC NULLS LAST`, desc(importsTable.id))
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

  // Serve from cache — movement for import N is immutable once N is committed
  // (it only depends on identity states of imports ≤ N, all of which are cached).
  const cachedMovement = movementResponseCache.get(params.data.id);
  if (cachedMovement) {
    res.json(cachedMovement);
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

  // Bound the history walk to the global WIP cutoff so movement ignores
  // pre-cutoff imports as if never uploaded. cutoffSql(null) is a no-op.
  const movementCutoff = await loadValidFrom();
  const priorImports = await db
    .select({ id: importsTable.id, createdAt: importsTable.createdAt })
    .from(importsTable)
    .where(and(
      or(
        lt(importsTable.reportDate, target.reportDate),
        and(eq(importsTable.reportDate, target.reportDate), lt(importsTable.id, target.id)),
      ),
      cutoffSql(movementCutoff),
    ))
    .orderBy(sql`${importsTable.reportDate} DESC NULLS LAST`, desc(importsTable.id));

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

  const movementResponse = {
    importId: target.id,
    hasHistory: priorImports.length > 0,
    items,
  };
  movementResponseCache.set(target.id, movementResponse);
  res.json(movementResponse);
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
  const cached = velocityStateCache.get(importId);
  if (cached) return cached;

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
  velocityStateCache.set(importId, out);
  return out;
}

// Today's date as a YYYY-MM-DD string (UTC). Used as the Order Review pairing
// fallback when a report has no parseable "As on" banner date.
function todayYmd(): string {
  const n = new Date();
  const m = String(n.getUTCMonth() + 1).padStart(2, "0");
  const d = String(n.getUTCDate()).padStart(2, "0");
  return `${n.getUTCFullYear()}-${m}-${d}`;
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

// Shared per-identity velocity computation: builds each mark's snapshot series
// from the import history and classifies via the deterministic domain engine.
// Used by both the /velocity route and the Overview /summary endpoint so their
// movement-status tallies can never disagree. Purely advisory / read-only.
async function computeVelocityItems(
  target: typeof importsTable.$inferSelect,
  settings: TurnaroundSettings,
) {
  const current = await loadVelocityStates(target.id);
  const currentMs = importDateMs(target.reportDate, target.createdAt);

  // Bound the history walk to the global WIP cutoff so velocity ignores
  // pre-cutoff imports as if never uploaded. cutoffSql(null) is a no-op.
  const velocityCutoff = await loadValidFrom();
  const priorImports = await db
    .select({
      id: importsTable.id,
      createdAt: importsTable.createdAt,
      reportDate: importsTable.reportDate,
    })
    .from(importsTable)
    .where(and(
      or(
        lt(importsTable.reportDate, target.reportDate),
        and(eq(importsTable.reportDate, target.reportDate), lt(importsTable.id, target.id)),
      ),
      cutoffSql(velocityCutoff),
    ))
    .orderBy(sql`${importsTable.reportDate} DESC NULLS LAST`, desc(importsTable.id));

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

  return { items, hasHistory: priorImports.length > 0, windowReports: priorImports.length + 1 };
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

  const { items, hasHistory, windowReports } = await computeVelocityItems(target, settings);

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
    hasHistory,
    windowReports,
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

// Contractor Performance report: a daily log of how much work (marks +
// weight) moved from one activity to the next, credited to the contractor of
// the FROM activity. Recomputed deterministically from the full import
// history on each read (and on each upload/delete/settings change).
router.get("/contractor-movement", async (_req, res): Promise<void> => {
  const entries = await recomputeContractorMovement();
  res.json({ entries, generatedAt: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// flagNewContractors — called after every WIP merge
// ---------------------------------------------------------------------------
// Inspects the newly committed import's contractor strings and inserts a
// pending contractor_dedup_proposals row for any string whose normalized form
// is not yet covered by:
//   (a) a contractor_categories entry
//   (b) a contractor_aliases alias key
//   (c) an existing pending or approved proposal (either as canonical or alias)
//
// A "new contractor" proposal has empty aliasEntries, confidence=null, and
// reason="New contractor name — not yet classified." Approving it will create
// a contractor_categories entry (UNCLASSIFIED) which the admin can then
// configure via the Contractors tab.
async function flagNewContractors(
  importId: number,
  log: { warn: (...a: unknown[]) => void },
): Promise<void> {
  // 1. Distinct contractor strings from the new import rows.
  // record_pool has no importId column — rows are joined via import_rows.
  const poolContractors = await db
    .selectDistinct({ contractor: recordPoolTable.contractor })
    .from(importRowsTable)
    .innerJoin(
      recordPoolTable,
      eq(importRowsTable.poolId, recordPoolTable.id),
    )
    .where(
      and(
        eq(importRowsTable.importId, importId),
        sql`${recordPoolTable.contractor} is not null and ${recordPoolTable.contractor} <> ''`,
      ),
    );

  if (poolContractors.length === 0) return;

  // 2. Build the set of already-covered normalized keys.
  const [catRows, aliasRows, proposalRows] = await Promise.all([
    db
      .select({ nameKey: contractorCategoriesTable.nameKey })
      .from(contractorCategoriesTable),
    db
      .select({ aliasKey: contractorAliasesTable.aliasKey })
      .from(contractorAliasesTable),
    db
      .select({
        canonicalKey: contractorDedupProposalsTable.canonicalKey,
        aliasEntries: contractorDedupProposalsTable.aliasEntries,
        status: contractorDedupProposalsTable.status,
      })
      .from(contractorDedupProposalsTable),
  ]);

  const covered = new Set<string>();
  for (const r of catRows) covered.add(r.nameKey);
  for (const r of aliasRows) covered.add(r.aliasKey);
  for (const p of proposalRows) {
    if (p.status !== "rejected") {
      covered.add(p.canonicalKey);
      for (const e of (p.aliasEntries as AliasEntry[]) ?? []) {
        covered.add(e.normalizedKey);
      }
    }
  }

  // 3. Collect new strings not yet covered.
  const newEntries: Array<{ raw: string; key: string }> = [];
  for (const { contractor } of poolContractors) {
    const raw = contractor?.trim();
    if (!raw) continue;
    const key = normalizeContractorName(raw);
    if (!covered.has(key)) {
      newEntries.push({ raw, key });
      covered.add(key); // prevent duplicates within the same batch
    }
  }

  if (newEntries.length === 0) return;

  // 4. Insert a pending proposal for each new string.
  for (const { raw, key } of newEntries) {
    try {
      await db
        .insert(contractorDedupProposalsTable)
        .values({
          canonicalKey: key,
          canonicalDisplay: raw,
          aliasEntries: [],
          confidence: null,
          reason: "New contractor name — not yet classified.",
          status: "pending",
        })
        .onConflictDoNothing(); // safe: no unique key clash expected, but guard anyway
    } catch (err) {
      log.warn({ err, raw, key }, "Failed to insert contractor dedup proposal");
    }
  }
}

// ---------------------------------------------------------------------------
// Startup cache warm-up
// ---------------------------------------------------------------------------
// Warms only the most recent WARM_LIMIT imports. The new import_rows(import_id)
// index makes any uncached import load in ~400 ms, so warming everything is
// unnecessary and caused OOM crashes on production (21 imports × 55 K rows
// each filled the 2 GB heap before the server accepted any requests).
const WARM_LIMIT = 3;

export async function warmMembershipCaches(): Promise<void> {
  const allImports = await db
    .select({ id: importsTable.id })
    .from(importsTable)
    .orderBy(sql`${importsTable.reportDate} DESC NULLS LAST`, desc(importsTable.id));

  // Warm identity states for EVERY import — these are needed by the movement
  // endpoint which walks the full history chain for each request. Identity
  // state rows are small (~100 bytes per mark) so loading all imports costs
  // ~125 MB at current data volumes, well within the available heap.
  for (const imp of allImports) {
    await loadIdentityStates(imp.id);
  }

  // Membership and velocity only for the most recent WARM_LIMIT imports —
  // full membership rows are ~500 bytes each and storing all imports would
  // exhaust memory (previous OOM at 21 imports × 55k rows).
  const recent = allImports.slice(0, WARM_LIMIT);
  for (const imp of recent) {
    await loadMembership(db, imp.id);
    await loadVelocityStates(imp.id);
  }
}

export default router;
