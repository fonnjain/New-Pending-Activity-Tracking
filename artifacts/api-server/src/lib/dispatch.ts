import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { cutoffSql, loadValidFrom } from "./cutoff";
import {
  db,
  importsTable,
  importRowsTable,
  recordPoolTable,
  orderDispatchTable,
  orderReviewImportsTable,
  orderReviewRowsTable,
  dispatchLedgerTable,
  type OrderDispatchRow,
  type DispatchLedgerRow,
  type OrderReviewChangeLog,
  type OrderReviewFieldChange,
} from "@workspace/db";
import { bundleActivitySet } from "@workspace/domain";
import {
  parseOrderReview,
  type ParsedOrderReviewRow,
} from "./parse-order-review";

// ---------------------------------------------------------------------------
// Dispatch engine (additive, deterministic, idempotent)
// ---------------------------------------------------------------------------
// Computes dispatch tonnage per (project, structure):
//   seedMt    = one-time baseline captured from the FIRST Order Review file
//               (capture-once). Kept for record/seed-time only; it is NOT part
//               of Computed Dispatch.
//   accruedMt = tonnes that LEFT the Yard (a mark identity at Y in a WIP import,
//               absent from the NEXT WIP import) across the FULL WIP history
//               (from the very first WIP file; the seed import is NOT a cutoff).
//               This alone is the Computed Dispatch figure (WIP-derived only;
//               the Order Review file never contributes).
// Like the milestone engine, recompute() replays the full WIP history and
// rebuilds the ledger from scratch, so it is idempotent and safe to run after
// every WIP commit and every import deletion. It NEVER mutates WIP parsing,
// activity, dedup, ageing, warning, or milestone state.

const YARD = bundleActivitySet("YARD") ?? new Set<string>(["Y"]);

function identityKey(markId: string, jobCardNo: string | null): string {
  return `${markId}\u0001${jobCardNo ?? ""}`;
}

function dispatchKey(project: string, structure: string): string {
  return `${project}\u0001${structure}`;
}

// The ledger date for an import: its report date (YYYY-MM-DD), else created_at.
function importYmd(reportDate: string | null, createdAt: Date | string): string {
  if (reportDate && /^\d{4}-\d{2}-\d{2}$/.test(reportDate)) return reportDate;
  const d = createdAt instanceof Date ? createdAt : new Date(createdAt);
  return d.toISOString().slice(0, 10);
}

// Seed order_dispatch ONCE per (project, structure) from a parsed Order Review
// file. Capture-once: a key already present is never re-seeded. seedImportId is
// the newest WIP import at seed time, so later Yard departures accrue on top.
// Returns the number of newly seeded keys.
export async function seedDispatchFromOrderReview(
  rows: ParsedOrderReviewRow[],
  seedDate: string | null,
): Promise<number> {
  if (rows.length === 0) return 0;

  // The newest WIP import at seed time (max id). Yard departures only accrue for
  // WIP import pairs after this id.
  const [newestWip] = await db
    .select({ id: importsTable.id })
    .from(importsTable)
    .orderBy(desc(importsTable.id))
    .limit(1);
  const seedImportId = newestWip?.id ?? null;

  // Collapse the file rows to one seed value per key (sum despatch across any
  // duplicate structure rows in the same project).
  const seedByKey = new Map<
    string,
    { project: string; structure: string; seedMt: number }
  >();
  for (const r of rows) {
    if (!r.structure) continue;
    const key = dispatchKey(r.project, r.structure);
    const entry = seedByKey.get(key);
    const mt = r.fileDespatchMt ?? 0;
    if (entry) entry.seedMt += mt;
    else
      seedByKey.set(key, {
        project: r.project,
        structure: r.structure,
        seedMt: mt,
      });
  }

  const values = Array.from(seedByKey.values()).map((v) => ({
    project: v.project,
    structure: v.structure,
    seedMt: v.seedMt,
    seedDate,
    seedImportId,
    accruedMt: 0,
  }));

  let seeded = 0;
  const chunk = 200;
  for (let i = 0; i < values.length; i += chunk) {
    const inserted = await db
      .insert(orderDispatchTable)
      .values(values.slice(i, i + chunk))
      .onConflictDoNothing({
        target: [orderDispatchTable.project, orderDispatchTable.structure],
      })
      .returning({ project: orderDispatchTable.project });
    seeded += inserted.length;
  }
  return seeded;
}

// Per-import projection used by the replay: present identities (for absence
// detection) and, for those at Yard, their (project, structure) + tonnage.
interface ImportYardState {
  present: Set<string>;
  yard: Map<string, { key: string; weightMt: number }>;
}

async function loadYardState(importId: number): Promise<ImportYardState> {
  const rows = await db
    .select({
      job: recordPoolTable.job,
      structure: recordPoolTable.structure,
      markId: recordPoolTable.markId,
      jobCardNo: recordPoolTable.jobCardNo,
      activity: recordPoolTable.activity,
      balanceWt: recordPoolTable.balanceWt,
      copies: importRowsTable.copies,
    })
    .from(importRowsTable)
    .innerJoin(recordPoolTable, eq(importRowsTable.poolId, recordPoolTable.id))
    .where(eq(importRowsTable.importId, importId));

  const present = new Set<string>();
  const yard = new Map<string, { key: string; weightMt: number }>();
  for (const r of rows) {
    const id = identityKey(r.markId, r.jobCardNo);
    present.add(id);
    const act = (r.activity ?? "").trim().toUpperCase();
    if (!YARD.has(act)) continue;
    const key = dispatchKey(r.job, r.structure);
    const mt = ((r.balanceWt ?? 0) * (r.copies ?? 1)) / 1000;
    const entry = yard.get(id);
    if (entry) entry.weightMt += mt;
    else yard.set(id, { key, weightMt: mt });
  }
  return { present, yard };
}

interface LedgerAccrual {
  key: string;
  project: string;
  structure: string;
  importId: number;
  entryDate: string;
  deltaMt: number;
}

// Deterministically recompute accrued dispatch + rebuild the ledger from the full
// WIP history. Idempotent: replay always yields the same accrual totals. Seeds
// (seedMt/seedDate/seedImportId) are preserved (capture-once); only accruedMt and
// the ledger are rewritten. Safe to call best-effort after any WIP commit/delete.
export async function recomputeDispatch(
  cutoffArg?: string | null,
): Promise<void> {
  // Global WIP cutoff: when set, only WIP imports on/after it accrue yard
  // departures (older imports ignored as if never uploaded). When null (the
  // default), cutoffSql is a no-op and the full-history replay is byte-identical
  // to before. Order Status reads the STORED accrual, so the bounded total is
  // persisted; it is fully rebuilt from (never-deleted) WIP history on every
  // recompute, so clearing the cutoff restores the full total.
  const cutoff = cutoffArg === undefined ? await loadValidFrom() : cutoffArg;
  const seeds = await db.select().from(orderDispatchTable);
  if (seeds.length === 0) {
    // No seeds yet: nothing to accrue. Keep the ledger empty.
    await db.delete(dispatchLedgerTable);
    return;
  }
  const seedByKey = new Map<string, OrderDispatchRow>(
    seeds.map((s) => [dispatchKey(s.project, s.structure), s]),
  );

  const imports = await db
    .select({
      id: importsTable.id,
      reportDate: importsTable.reportDate,
      createdAt: importsTable.createdAt,
    })
    .from(importsTable)
    .where(cutoffSql(cutoff))
    .orderBy(asc(importsTable.id));

  const accrualsByKey = new Map<string, LedgerAccrual[]>();
  let prev: ImportYardState | null = null;
  for (const imp of imports) {
    const cur = await loadYardState(imp.id);
    if (prev) {
      const ymd = importYmd(imp.reportDate, imp.createdAt);
      // Aggregate departures (at Yard in prev, absent in cur) per key for this pair.
      const deltaByKey = new Map<string, number>();
      for (const [id, info] of prev.yard) {
        if (cur.present.has(id)) continue; // still present -> not departed
        deltaByKey.set(info.key, (deltaByKey.get(info.key) ?? 0) + info.weightMt);
      }
      for (const [key, delta] of deltaByKey) {
        const seed = seedByKey.get(key);
        if (!seed) continue; // only accrue for keys present in the order book
        // Computed Dispatch counts ALL yard departures across the full WIP
        // history (from the very first WIP file). The Order Review seed import
        // is NOT a cutoff — the file never bounds the WIP-derived figure.
        if (delta === 0) continue;
        const list = accrualsByKey.get(key) ?? [];
        list.push({
          key,
          project: seed.project,
          structure: seed.structure,
          importId: imp.id,
          entryDate: ymd,
          deltaMt: delta,
        });
        accrualsByKey.set(key, list);
      }
    }
    prev = cur;
  }

  // Rebuild the ledger + accruedMt in one transaction.
  await db.transaction(async (tx) => {
    await tx.delete(dispatchLedgerTable);

    const ledgerInserts: (typeof dispatchLedgerTable.$inferInsert)[] = [];
    const accruedUpdates: { key: string; accruedMt: number }[] = [];

    for (const [key, seed] of seedByKey) {
      // Computed Dispatch is WIP-only: the running total starts at 0 (no Order
      // Review seed baseline). Only wip_departure entries build the ledger.
      let running = 0;
      const accruals = (accrualsByKey.get(key) ?? []).sort(
        (a, b) => a.importId - b.importId,
      );
      let accrued = 0;
      for (const a of accruals) {
        running += a.deltaMt;
        accrued += a.deltaMt;
        ledgerInserts.push({
          project: a.project,
          structure: a.structure,
          entryDate: a.entryDate,
          deltaMt: a.deltaMt,
          runningMt: running,
          source: "wip_departure",
          importId: a.importId,
        });
      }
      accruedUpdates.push({ key, accruedMt: accrued });
    }

    const chunk = 500;
    for (let i = 0; i < ledgerInserts.length; i += chunk) {
      await tx.insert(dispatchLedgerTable).values(ledgerInserts.slice(i, i + chunk));
    }
    for (const u of accruedUpdates) {
      const seed = seedByKey.get(u.key)!;
      await tx
        .update(orderDispatchTable)
        .set({ accruedMt: u.accruedMt, updatedAt: new Date() })
        .where(
          and(
            eq(orderDispatchTable.project, seed.project),
            eq(orderDispatchTable.structure, seed.structure),
          ),
        );
    }
  });
}

export interface DispatchReconciliationRow {
  project: string;
  structure: string;
  fileDespatchMt: number | null;
  computedDispatchMt: number;
  diffMt: number | null;
  diffPct: number | null;
  status: "match" | "mismatch" | "no_file" | "no_computed";
}

export interface DispatchReconciliation {
  tolerancePct: number;
  matched: number;
  mismatched: number;
  rows: DispatchReconciliationRow[];
}

// Cross-check the latest Order Review file's stated Despatch MT against the
// computed running dispatch, per (project, structure), at a 1% tolerance.
export function crossCheckDispatch(
  fileRows: { project: string; structure: string; fileDespatchMt: number | null }[],
  dispatchRows: OrderDispatchRow[],
  tolerancePct = 1,
): DispatchReconciliation {
  const computedByKey = new Map<string, number>();
  for (const d of dispatchRows) {
    // Computed Dispatch is WIP-derived only (Yard departures). The Order Review
    // seed baseline never contributes to the figure reconciled against the file.
    computedByKey.set(dispatchKey(d.project, d.structure), d.accruedMt);
  }
  const fileByKey = new Map<
    string,
    { project: string; structure: string; fileDespatchMt: number | null }
  >();
  for (const r of fileRows) {
    const key = dispatchKey(r.project, r.structure);
    const entry = fileByKey.get(key);
    if (entry) {
      entry.fileDespatchMt =
        (entry.fileDespatchMt ?? 0) + (r.fileDespatchMt ?? 0);
    } else {
      fileByKey.set(key, { ...r });
    }
  }

  const keys = new Set<string>([...computedByKey.keys(), ...fileByKey.keys()]);
  const rows: DispatchReconciliationRow[] = [];
  let matched = 0;
  let mismatched = 0;
  for (const key of keys) {
    const f = fileByKey.get(key);
    const computed = computedByKey.get(key);
    const fileMt = f?.fileDespatchMt ?? null;
    const [project, structure] = key.split("\u0001");
    if (computed == null) {
      rows.push({
        project: f?.project ?? project,
        structure: f?.structure ?? structure,
        fileDespatchMt: fileMt,
        computedDispatchMt: 0,
        diffMt: null,
        diffPct: null,
        status: "no_computed",
      });
      continue;
    }
    if (fileMt == null) {
      rows.push({
        project: f?.project ?? project,
        structure: f?.structure ?? structure,
        fileDespatchMt: null,
        computedDispatchMt: computed,
        diffMt: null,
        diffPct: null,
        status: "no_file",
      });
      continue;
    }
    const diffMt = computed - fileMt;
    const denom = Math.max(Math.abs(fileMt), 1e-9);
    const diffPct = (diffMt / denom) * 100;
    const within = Math.abs(diffPct) <= tolerancePct;
    if (within) matched++;
    else mismatched++;
    rows.push({
      project: f?.project ?? project,
      structure: f?.structure ?? structure,
      fileDespatchMt: fileMt,
      computedDispatchMt: computed,
      diffMt,
      diffPct,
      status: within ? "match" : "mismatch",
    });
  }
  rows.sort(
    (a, b) =>
      a.project.localeCompare(b.project) ||
      a.structure.localeCompare(b.structure),
  );
  return { tolerancePct, matched, mismatched, rows };
}

// One (project, structure) row comparing the file-stated balances (col S / col W)
// against the balances computed from WO Order Qty (col J) minus Release (col L) /
// Despatch (col Q). Each leg has its own status.
export interface BalanceReconciliationRow {
  project: string;
  structure: string;
  woOrderQtyMt: number | null;
  // Release balance leg: computed (J - L) vs file (col S).
  computedReleaseBalanceMt: number | null;
  fileReleaseBalanceMt: number | null;
  releaseDiffMt: number | null;
  releaseDiffPct: number | null;
  releaseStatus: "match" | "mismatch" | "no_file" | "no_computed";
  // Despatch balance leg: computed (J - Q) vs file (col W).
  computedDispatchBalanceMt: number | null;
  fileDispatchBalanceMt: number | null;
  dispatchDiffMt: number | null;
  dispatchDiffPct: number | null;
  dispatchStatus: "match" | "mismatch" | "no_file" | "no_computed";
}

export interface BalanceReconciliation {
  tolerancePct: number;
  absFloorMt: number;
  releaseMatched: number;
  releaseMismatched: number;
  dispatchMatched: number;
  dispatchMismatched: number;
  rows: BalanceReconciliationRow[];
}

interface BalanceLeg {
  computed: number | null;
  file: number | null;
  diffMt: number | null;
  diffPct: number | null;
  status: "match" | "mismatch" | "no_file" | "no_computed";
}

// Classify one balance leg. computed is null when WO Order Qty is missing; file is
// null when the file balance cell is blank. A leg is a match when EITHER the % diff
// is within tolerance OR the absolute diff is below the small floor (so near-zero
// bases don't flag on rounding noise).
function classifyBalanceLeg(
  computed: number | null,
  file: number | null,
  tolerancePct: number,
  absFloorMt: number,
): BalanceLeg {
  if (computed == null)
    return { computed, file, diffMt: null, diffPct: null, status: "no_computed" };
  if (file == null)
    return { computed, file, diffMt: null, diffPct: null, status: "no_file" };
  const diffMt = computed - file;
  const denom = Math.max(Math.abs(file), 1e-9);
  const diffPct = (diffMt / denom) * 100;
  const within =
    Math.abs(diffMt) <= absFloorMt || Math.abs(diffPct) <= tolerancePct;
  return { computed, file, diffMt, diffPct, status: within ? "match" : "mismatch" };
}

// Cross-check the file-stated Balance Release (col S) and Balance Despatch (col W)
// against the balances computed from WO Order Qty (col J): J - Release (col L) and
// J - Despatch (col Q). Purely a data-quality overlay — reports agreement, never
// changes any stored figure.
export function crossCheckBalance(
  fileRows: {
    project: string;
    structure: string;
    woOrderQtyMt: number | null;
    releaseMt: number | null;
    fileDespatchMt: number | null;
    fileBalReleaseMt: number | null;
    fileBalDespatchMt: number | null;
  }[],
  tolerancePct = 1,
  absFloorMt = 0.05,
): BalanceReconciliation {
  const rows: BalanceReconciliationRow[] = [];
  let releaseMatched = 0;
  let releaseMismatched = 0;
  let dispatchMatched = 0;
  let dispatchMismatched = 0;

  for (const r of fileRows) {
    const wo = r.woOrderQtyMt;
    const computedRelease = wo == null ? null : wo - (r.releaseMt ?? 0);
    const computedDispatch = wo == null ? null : wo - (r.fileDespatchMt ?? 0);
    const rel = classifyBalanceLeg(
      computedRelease,
      r.fileBalReleaseMt,
      tolerancePct,
      absFloorMt,
    );
    const dis = classifyBalanceLeg(
      computedDispatch,
      r.fileBalDespatchMt,
      tolerancePct,
      absFloorMt,
    );
    if (rel.status === "match") releaseMatched++;
    else if (rel.status === "mismatch") releaseMismatched++;
    if (dis.status === "match") dispatchMatched++;
    else if (dis.status === "mismatch") dispatchMismatched++;
    rows.push({
      project: r.project,
      structure: r.structure,
      woOrderQtyMt: wo,
      computedReleaseBalanceMt: rel.computed,
      fileReleaseBalanceMt: rel.file,
      releaseDiffMt: rel.diffMt,
      releaseDiffPct: rel.diffPct,
      releaseStatus: rel.status,
      computedDispatchBalanceMt: dis.computed,
      fileDispatchBalanceMt: dis.file,
      dispatchDiffMt: dis.diffMt,
      dispatchDiffPct: dis.diffPct,
      dispatchStatus: dis.status,
    });
  }
  rows.sort(
    (a, b) =>
      a.project.localeCompare(b.project) ||
      a.structure.localeCompare(b.structure),
  );
  return {
    tolerancePct,
    absFloorMt,
    releaseMatched,
    releaseMismatched,
    dispatchMatched,
    dispatchMismatched,
    rows,
  };
}

// Distinct (project, structure) keys present in the NEWEST WIP import — the same
// import the Order Status page joins against. Empty when no WIP import exists.
async function loadNewestWipStructureKeys(): Promise<Set<string>> {
  const [newest] = await db
    .select({ id: importsTable.id })
    .from(importsTable)
    .orderBy(desc(importsTable.id))
    .limit(1);
  const keys = new Set<string>();
  if (!newest) return keys;
  const rows = await db
    .select({
      job: recordPoolTable.job,
      structure: recordPoolTable.structure,
    })
    .from(importRowsTable)
    .innerJoin(recordPoolTable, eq(importRowsTable.poolId, recordPoolTable.id))
    .where(eq(importRowsTable.importId, newest.id));
  for (const r of rows) keys.add(dispatchKey(r.job, r.structure));
  return keys;
}

// Count how many of a file's distinct (project, structure) keys match a WIP
// structure in the newest import vs not. Join-coverage metric, surfaced in the
// intake summary so users can see how much of the file actually maps to WIP.
export async function computeWipCoverage(
  rows: ParsedOrderReviewRow[],
): Promise<{ matchedToWip: number; unmatchedToWip: number }> {
  const wipKeys = await loadNewestWipStructureKeys();
  const fileKeys = new Set<string>();
  for (const r of rows) {
    if (!r.structure) continue;
    fileKeys.add(dispatchKey(r.project, r.structure));
  }
  let matched = 0;
  for (const k of fileKeys) if (wipKeys.has(k)) matched++;
  return { matchedToWip: matched, unmatchedToWip: fileKeys.size - matched };
}

// The latest Order Review ingest (for as-on date / summary / change log) plus the
// FULL set of current order rows (one per project+structure, UPSERTed across all
// uploads). Each row carries importId = the import it was last seen in, so callers
// can flag rows absent from the latest file. Null when no ingest has happened.
export async function loadLatestOrderReview(): Promise<{
  import: typeof orderReviewImportsTable.$inferSelect;
  rows: (typeof orderReviewRowsTable.$inferSelect)[];
} | null> {
  // Run both queries in parallel — the import header and the full row set are
  // independent reads.  If no import exists the row scan is wasted work, but
  // it is cheap when the table is empty and saves a full round-trip otherwise.
  const [latest] = await db
    .select()
    .from(orderReviewImportsTable)
    // Sort by as_on_date (the date the source file represents) rather than the
    // database row id or created_at.  The bulk-upload on 10-Aug assigned higher
    // ids to older-dated files, so id order is not date order.  NULLS LAST
    // ensures imports without an as_on_date fall below imports that have one;
    // the secondary id DESC tiebreaker gives a deterministic winner when two
    // imports share the same as_on_date.
    .orderBy(sql`${orderReviewImportsTable.asOnDate} DESC NULLS LAST`, desc(orderReviewImportsTable.id))
    .limit(1);
  if (!latest) return null;
  const rows = await db
    .select()
    .from(orderReviewRowsTable)
    .where(eq(orderReviewRowsTable.importId, latest.id));
  return { import: latest, rows };
}

export interface IngestOrderReviewResult {
  importId: number;
  asOnDate: string | null;
  summary: ReturnType<typeof parseOrderReview>["summary"];
  seeded: number;
}

// The order-book value fields compared for idempotency / change detection. As-on
// date is an import-level (not per-key) field, reported in the change-log header.
const ORDER_REVIEW_VALUE_FIELDS = [
  "subType",
  "sets",
  "weightMt",
  "woOrderQtyMt",
  "bomType",
  "releaseMt",
  "fabMt",
  "galvMt",
  "inspectionMt",
  "fileDespatchMt",
  "balWoMt",
  "fileBalReleaseMt",
  "fileBalDespatchMt",
  "balFabMt",
  "balGalvMt",
] as const;
type OrderReviewValues = Pick<
  ParsedOrderReviewRow,
  (typeof ORDER_REVIEW_VALUE_FIELDS)[number]
>;

// Case-insensitive structure match key (project is already normalized). Structure
// CASE is preserved in storage for the WIP join; only the dedup KEY upper-cases so
// daily files with case drift resolve to the same current row.
function matchKey(project: string, structure: string): string {
  return `${project}\u0001${structure.toUpperCase()}`;
}

// Collapse parsed rows to ONE value set per (project, structure) match key. The
// Order Review file is unique per key, but defensively sum numeric measures and
// take the first non-null text if a key repeats — mirrors the dispatch-seed sum.
function collapseOrderRows(
  rows: ParsedOrderReviewRow[],
): Map<string, ParsedOrderReviewRow> {
  const byKey = new Map<string, ParsedOrderReviewRow>();
  for (const r of rows) {
    if (!r.structure) continue;
    const key = matchKey(r.project, r.structure);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...r });
      continue;
    }
    prev.subType = prev.subType ?? r.subType;
    prev.bomType = prev.bomType ?? r.bomType;
    const addNum = (a: number | null, b: number | null): number | null =>
      a == null && b == null ? null : (a ?? 0) + (b ?? 0);
    prev.sets = addNum(prev.sets, r.sets);
    prev.weightMt = addNum(prev.weightMt, r.weightMt);
    prev.woOrderQtyMt = addNum(prev.woOrderQtyMt, r.woOrderQtyMt);
    prev.releaseMt = addNum(prev.releaseMt, r.releaseMt);
    prev.fabMt = addNum(prev.fabMt, r.fabMt);
    prev.galvMt = addNum(prev.galvMt, r.galvMt);
    prev.inspectionMt = addNum(prev.inspectionMt, r.inspectionMt);
    prev.fileDespatchMt = addNum(prev.fileDespatchMt, r.fileDespatchMt);
    prev.balWoMt = addNum(prev.balWoMt, r.balWoMt);
    prev.fileBalReleaseMt = addNum(prev.fileBalReleaseMt, r.fileBalReleaseMt);
    prev.fileBalDespatchMt = addNum(prev.fileBalDespatchMt, r.fileBalDespatchMt);
    prev.balFabMt = addNum(prev.balFabMt, r.balFabMt);
    prev.balGalvMt = addNum(prev.balGalvMt, r.balGalvMt);
  }
  return byKey;
}

// Field-level diff of stored vs incoming values; empty = identical (no value change).
function diffOrderValues(
  before: OrderReviewValues,
  after: OrderReviewValues,
): OrderReviewFieldChange[] {
  const changes: OrderReviewFieldChange[] = [];
  for (const field of ORDER_REVIEW_VALUE_FIELDS) {
    const a = before[field] ?? null;
    const b = after[field] ?? null;
    if (a !== b) changes.push({ field, from: a, to: b });
  }
  return changes;
}

// Ingest one Order Review file as an idempotent daily snapshot: log the upload in
// order_review_imports (with its change log), then UPSERT the one current row per
// (project, structure) — insert new keys, update changed values IN PLACE, leave
// identical rows untouched (only bump last-seen importId), and FLAG (keep, never
// delete) keys absent from this file. Then capture-once seed any new dispatch keys
// and deterministically recompute accrued dispatch + ledger. Purely additive —
// never touches WIP state, and never mutates the append-only dispatch ledger
// logic (it is rebuilt from WIP yard-departures, unaffected by order-book edits).
export async function ingestOrderReview(
  buffer: Buffer,
  meta: { sourceFilename: string; label: string | null; asOnDate?: string | null },
): Promise<IngestOrderReviewResult> {
  const parsed = parseOrderReview(buffer);
  const coverage = await computeWipCoverage(parsed.rows);
  const summary = { ...parsed.summary, ...coverage };

  const [imp] = await db
    .insert(orderReviewImportsTable)
    .values({
      label: meta.label,
      sourceFilename: meta.sourceFilename,
      // Prefer caller-supplied date (user-selected), else fall back to file banner.
      asOnDate: meta.asOnDate ?? parsed.asOnDate,
      summary,
    })
    .returning({ id: orderReviewImportsTable.id });

  const incoming = collapseOrderRows(parsed.rows);

  const changeLog: OrderReviewChangeLog = {
    inserted: [],
    updated: [],
    unchanged: 0,
    flagged: [],
  };

  await db.transaction(async (tx) => {
    // Read all existing rows.  When legacy data has multiple BOM rows per
    // (project, structure) — Proto, Mass, Pre stored individually instead of
    // as a single BOM-summed aggregate — only the FIRST row encountered per
    // key is kept for change-detection; the extra rows are swept away by the
    // delete-then-insert strategy below.
    const existing = await tx.select().from(orderReviewRowsTable);
    const existingByKey = new Map<string, typeof existing[number]>();
    for (const row of existing) {
      const key = matchKey(row.project, row.structure);
      if (!existingByKey.has(key)) existingByKey.set(key, row);
    }

    // Compute change log: compare the first-seen existing row per key against
    // the incoming BOM-summed row (values will differ whenever the DB held
    // individual BOM rows rather than a summed aggregate).
    for (const [key, r] of incoming) {
      const prior = existingByKey.get(key);
      if (!prior) {
        changeLog.inserted.push({ project: r.project, structure: r.structure });
      } else {
        const changes = diffOrderValues(prior, r);
        if (changes.length === 0) changeLog.unchanged++;
        else
          changeLog.updated.push({
            project: prior.project,
            structure: prior.structure,
            changes,
          });
      }
    }
    for (const [key, row] of existingByKey) {
      if (!incoming.has(key)) {
        changeLog.flagged.push({ project: row.project, structure: row.structure });
      }
    }

    // Delete ALL existing rows whose key appears in the incoming set.  This
    // includes any legacy BOM-row duplicates (e.g. a separate Mass row and a
    // separate Proto row for the same structure) that accumulated when the DB
    // was loaded before per-structure BOM collapsing was enforced.  The fresh
    // insert below replaces them with exactly ONE BOM-summed row per key.
    // Rows absent from this file (flagged) are not touched.
    const chunk = 500;
    const idsToDelete = existing
      .filter((row) => incoming.has(matchKey(row.project, row.structure)))
      .map((row) => row.id);
    for (let i = 0; i < idsToDelete.length; i += chunk) {
      await tx
        .delete(orderReviewRowsTable)
        .where(inArray(orderReviewRowsTable.id, idsToDelete.slice(i, i + chunk)));
    }

    // Insert ONE BOM-summed row per (project, structure) for every key present
    // in this file.  All rows carry the current importId so notInLatest is
    // correctly false for structures appearing in this upload.
    const toInsert = Array.from(incoming.values()).map((r) => ({
      importId: imp.id,
      project: r.project,
      structure: r.structure,
      subType: r.subType,
      sets: r.sets,
      weightMt: r.weightMt,
      woOrderQtyMt: r.woOrderQtyMt,
      bomType: r.bomType,
      releaseMt: r.releaseMt,
      fabMt: r.fabMt,
      galvMt: r.galvMt,
      inspectionMt: r.inspectionMt,
      fileDespatchMt: r.fileDespatchMt,
      balWoMt: r.balWoMt,
      fileBalReleaseMt: r.fileBalReleaseMt,
      fileBalDespatchMt: r.fileBalDespatchMt,
      balFabMt: r.balFabMt,
      balGalvMt: r.balGalvMt,
    }));
    for (let i = 0; i < toInsert.length; i += chunk) {
      await tx
        .insert(orderReviewRowsTable)
        .values(toInsert.slice(i, i + chunk));
    }
    // Rows absent from this file are left in place (flagged by importId mismatch).
  });

  await db
    .update(orderReviewImportsTable)
    .set({ changeLog })
    .where(eq(orderReviewImportsTable.id, imp.id));

  const seeded = await seedDispatchFromOrderReview(parsed.rows, parsed.asOnDate);
  await recomputeDispatch();

  return {
    importId: imp.id,
    asOnDate: parsed.asOnDate,
    summary,
    seeded,
  };
}

export type { OrderDispatchRow, DispatchLedgerRow };
