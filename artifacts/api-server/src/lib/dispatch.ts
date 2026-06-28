import { and, asc, desc, eq } from "drizzle-orm";
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
} from "@workspace/db";
import { bundleActivitySet } from "@workspace/domain";
import {
  parseOrderReview,
  type ParsedOrderReviewRow,
} from "./parse-order-review";

// ---------------------------------------------------------------------------
// Dispatch engine (additive, deterministic, idempotent)
// ---------------------------------------------------------------------------
// Computes a running Dispatch tonnage per (project, structure):
//   seedMt    = one-time baseline from the FIRST Order Review file (capture-once).
//   accruedMt = tonnes that LEFT the Yard (a mark identity at Y in a WIP import,
//               absent from the NEXT WIP import) across import pairs AFTER the
//               key's seed import.
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
export async function recomputeDispatch(): Promise<void> {
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
        if (!seed) continue; // only accrue for seeded keys
        // Only count departures AFTER the key was seeded.
        if (seed.seedImportId != null && imp.id <= seed.seedImportId) continue;
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
      let running = seed.seedMt;
      // Seed entry first.
      ledgerInserts.push({
        project: seed.project,
        structure: seed.structure,
        entryDate: seed.seedDate,
        deltaMt: seed.seedMt,
        runningMt: running,
        source: "seed",
        importId: null,
      });
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
    computedByKey.set(
      dispatchKey(d.project, d.structure),
      d.seedMt + d.accruedMt,
    );
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

// The latest Order Review ingest (newest wins), with its rows. Null when none.
export async function loadLatestOrderReview(): Promise<{
  import: typeof orderReviewImportsTable.$inferSelect;
  rows: (typeof orderReviewRowsTable.$inferSelect)[];
} | null> {
  const [latest] = await db
    .select()
    .from(orderReviewImportsTable)
    .orderBy(desc(orderReviewImportsTable.id))
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

// Ingest one Order Review file: create an immutable order_review_imports row +
// its per-(project, structure) rows, capture-once seed any new dispatch keys,
// then deterministically recompute accrued dispatch + ledger. Newest ingest wins
// for display. Purely additive — never touches WIP state.
export async function ingestOrderReview(
  buffer: Buffer,
  meta: { sourceFilename: string; label: string | null },
): Promise<IngestOrderReviewResult> {
  const parsed = parseOrderReview(buffer);

  const [imp] = await db
    .insert(orderReviewImportsTable)
    .values({
      label: meta.label,
      sourceFilename: meta.sourceFilename,
      asOnDate: parsed.asOnDate,
      summary: parsed.summary,
    })
    .returning({ id: orderReviewImportsTable.id });

  const rowValues = parsed.rows.map((r) => ({
    importId: imp.id,
    project: r.project,
    structure: r.structure,
    subType: r.subType,
    sets: r.sets,
    weightMt: r.weightMt,
    bomType: r.bomType,
    releaseMt: r.releaseMt,
    fileDespatchMt: r.fileDespatchMt,
  }));
  const chunk = 500;
  for (let i = 0; i < rowValues.length; i += chunk) {
    await db.insert(orderReviewRowsTable).values(rowValues.slice(i, i + chunk));
  }

  const seeded = await seedDispatchFromOrderReview(parsed.rows, parsed.asOnDate);
  await recomputeDispatch();

  return {
    importId: imp.id,
    asOnDate: parsed.asOnDate,
    summary: parsed.summary,
    seeded,
  };
}

export type { OrderDispatchRow, DispatchLedgerRow };
