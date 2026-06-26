import { asc, eq, ne, sql } from "drizzle-orm";
import {
  db,
  importsTable,
  importRowsTable,
  recordPoolTable,
  projectMilestonesTable,
  settingsTable,
  SETTINGS_SINGLETON_ID,
} from "@workspace/db";
import {
  isKnownIn,
  rankIn,
  sequenceForCategory,
  cumulativeTarget,
  migrateTurnaroundSettings,
  type TurnaroundSettings,
} from "@workspace/domain";

// Project-less rows (RSJ Pole / Earthing / General) carry this sentinel job and
// are NOT a project — excluded from milestones entirely.
const UNASSIGNED = "(Unassigned)";

// A mark "blocks" the Ready milestone while it is still in an earlier activity
// (any known step before the FINAL stage of its OWN sequence). Y is the terminal
// stage in every sequence (TLT + all NTLT), but NTLT-specific steps like NTF are
// unknown to the TLT route — so the block test must use the mark's own sequence
// or those marks would be wrongly treated as "past Y" and never block.
function blocksReady(
  activity: string | null,
  category: string | null,
  ntltSubtype: string | null,
): boolean {
  const sequence = sequenceForCategory(category, ntltSubtype);
  const finalRank = sequence.length - 1;
  return isKnownIn(sequence, activity) && rankIn(sequence, activity) < finalRank;
}

export interface ProjectMilestone {
  project: string;
  projectStart: string | null;
  readyDate: string | null;
  readyTurnaroundDays: number | null;
  dispatchedDate: string | null;
  dispatchedTurnaroundDays: number | null;
  dispatchLagDays: number | null;
  marksTotal: number;
  plannedReadyDays: number | null;
  varianceReadyDays: number | null;
  limitedHistory: boolean;
  reopened: boolean;
}

// Mark identity for "ever seen" sets — matches the change-log / movement engines.
function identityKey(markId: string, jobCardNo: string | null): string {
  return `${markId}\u0001${jobCardNo ?? ""}`;
}

// The milestone date for an import: its report date (YYYY-MM-DD), else created_at.
function importYmd(reportDate: string | null, createdAt: Date | string): string {
  if (reportDate && /^\d{4}-\d{2}-\d{2}$/.test(reportDate)) return reportDate;
  const d = createdAt instanceof Date ? createdAt : new Date(createdAt);
  return d.toISOString().slice(0, 10);
}

// Whole days between two YYYY-MM-DD dates (UTC), clamped to >= 0. Null if either
// date is missing/unparseable.
function dayDiff(later: string | null, earlier: string | null): number | null {
  if (!later || !earlier) return null;
  const a = Date.parse(`${later}T00:00:00Z`);
  const b = Date.parse(`${earlier}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / 86_400_000));
}

interface WalkState {
  // Appeared in some PRIOR import (used to detect "now absent" = dispatched).
  seenBefore: boolean;
  // Ever observed present with a mark still in an earlier activity (in-progress).
  inProgressObserved: boolean;
  readyDate: string | null;
  readyImportId: number | null;
  dispatchedDate: string | null;
  dispatchedImportId: number | null;
  reopened: boolean;
  limitedHistory: boolean;
  identities: Set<string>;
}

function newState(): WalkState {
  return {
    seenBefore: false,
    inProgressObserved: false,
    readyDate: null,
    readyImportId: null,
    dispatchedDate: null,
    dispatchedImportId: null,
    reopened: false,
    limitedHistory: false,
    identities: new Set<string>(),
  };
}

// Deterministically recompute per-project turnaround milestones from the full
// append-only import history, MERGE with any already-captured dates (capture-once
// — a stored milestone date is never overwritten), persist, and return the
// resolved items. Replaying from the beginning always finds the EARLIEST
// qualifying import, so the result is idempotent and a later (possibly partial)
// file can never move a captured date. Purely additive — reads only; never
// touches parsing / activity / dedup / ageing / warning / velocity.
export async function recomputeMilestones(): Promise<ProjectMilestone[]> {
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

  // Chronological (arrival) order, matching the velocity / movement walks.
  const imports = await db
    .select({
      id: importsTable.id,
      reportDate: importsTable.reportDate,
      createdAt: importsTable.createdAt,
    })
    .from(importsTable)
    .orderBy(asc(importsTable.id));

  const states = new Map<string, WalkState>();

  for (const imp of imports) {
    // Light per-membership projection for this import (no full row expansion).
    const rows = await db
      .select({
        job: recordPoolTable.job,
        markId: recordPoolTable.markId,
        jobCardNo: recordPoolTable.jobCardNo,
        activity: recordPoolTable.activity,
        category: recordPoolTable.category,
        ntltSubtype: recordPoolTable.ntltSubtype,
      })
      .from(importRowsTable)
      .innerJoin(recordPoolTable, eq(importRowsTable.poolId, recordPoolTable.id))
      .where(eq(importRowsTable.importId, imp.id));

    const present = new Map<string, { anyEarlier: boolean; ids: Set<string> }>();
    for (const r of rows) {
      if (r.job === UNASSIGNED) continue;
      let p = present.get(r.job);
      if (!p) {
        p = { anyEarlier: false, ids: new Set<string>() };
        present.set(r.job, p);
      }
      p.ids.add(identityKey(r.markId, r.jobCardNo));
      if (blocksReady(r.activity, r.category, r.ntltSubtype)) {
        p.anyEarlier = true;
      }
    }

    const ymd = importYmd(imp.reportDate, imp.createdAt);

    // 1) Present projects: accumulate identities, capture Ready, detect re-open.
    for (const [project, info] of present) {
      let st = states.get(project);
      if (!st) {
        st = newState();
        states.set(project, st);
      }
      for (const id of info.ids) st.identities.add(id);
      if (info.anyEarlier) st.inProgressObserved = true;
      // Ready: present, has marks, and none still in an earlier activity.
      if (st.readyDate === null && info.ids.size > 0 && !info.anyEarlier) {
        st.readyDate = ymd;
        st.readyImportId = imp.id;
        if (!st.inProgressObserved) st.limitedHistory = true;
      }
      // Re-open anomaly: a mark is back in an earlier activity after Ready.
      if (st.readyDate !== null && info.anyEarlier) st.reopened = true;
    }

    // 2) Dispatched: a project seen before is now entirely absent.
    for (const [project, st] of states) {
      const isPresent = present.has(project);
      if (!isPresent && st.seenBefore && st.dispatchedDate === null) {
        st.dispatchedDate = ymd;
        st.dispatchedImportId = imp.id;
        // Same-import double-capture: went straight to gone without ever being
        // observed all-in-yard. Stamp Ready at the same date (lag 0).
        if (st.readyDate === null) {
          st.readyDate = ymd;
          st.readyImportId = imp.id;
          if (!st.inProgressObserved) st.limitedHistory = true;
        }
      }
      if (isPresent) st.seenBefore = true;
    }
  }

  // Earliest Assign Date per project across the whole permanent pool.
  const startRows = await db
    .select({
      job: recordPoolTable.job,
      start: sql<string | null>`min(${recordPoolTable.assignDate})`,
    })
    .from(recordPoolTable)
    .where(ne(recordPoolTable.job, UNASSIGNED))
    .groupBy(recordPoolTable.job);
  const startByJob = new Map<string, string | null>();
  for (const s of startRows) startByJob.set(s.job, s.start);

  // Capture-once merge: a stored milestone date always wins over a recomputed one
  // (they agree while history is intact; the stored value survives if history is
  // ever truncated).
  const existingRows = await db.select().from(projectMilestonesTable);
  const existing = new Map(existingRows.map((r) => [r.project, r]));

  const items: ProjectMilestone[] = [];
  const upserts: (typeof projectMilestonesTable.$inferInsert)[] = [];

  // Materialize over the UNION of replayed projects and already-stored milestone
  // rows, so a previously captured project that no longer appears in the current
  // history (import deleted/pruned, partial-history environment) is still
  // returned and re-persisted unchanged — honouring capture-once permanence.
  const allProjects = new Set<string>([...states.keys(), ...existing.keys()]);
  for (const project of allProjects) {
    const st = states.get(project);
    const ex = existing.get(project);
    const projectStart = startByJob.get(project) ?? ex?.projectStart ?? null;
    const readyDate = ex?.readyDate ?? st?.readyDate ?? null;
    const readyImportId = ex?.readyImportId ?? st?.readyImportId ?? null;
    const dispatchedDate = ex?.dispatchedDate ?? st?.dispatchedDate ?? null;
    const dispatchedImportId =
      ex?.dispatchedImportId ?? st?.dispatchedImportId ?? null;
    const marksTotal = Math.max(st?.identities.size ?? 0, ex?.marksTotal ?? 0);
    const reopened = (st?.reopened ?? false) || (ex?.reopened ?? false);
    const limitedHistory = ex?.limitedHistory ?? st?.limitedHistory ?? false;

    const readyTurnaroundDays = dayDiff(readyDate, projectStart);
    const dispatchedTurnaroundDays = dayDiff(dispatchedDate, projectStart);
    const dispatchLagDays =
      readyTurnaroundDays !== null && dispatchedTurnaroundDays !== null
        ? Math.max(0, dispatchedTurnaroundDays - readyTurnaroundDays)
        : null;
    const plannedReadyDays = cumulativeTarget("Y", settings, project);
    const varianceReadyDays =
      readyTurnaroundDays !== null && plannedReadyDays !== null
        ? readyTurnaroundDays - plannedReadyDays
        : null;

    items.push({
      project,
      projectStart,
      readyDate,
      readyTurnaroundDays,
      dispatchedDate,
      dispatchedTurnaroundDays,
      dispatchLagDays,
      marksTotal,
      plannedReadyDays,
      varianceReadyDays,
      limitedHistory,
      reopened,
    });
    upserts.push({
      project,
      projectStart,
      readyDate,
      readyImportId,
      readyTurnaroundDays,
      dispatchedDate,
      dispatchedImportId,
      dispatchedTurnaroundDays,
      dispatchLagDays,
      marksTotal,
      plannedReadyDays,
      varianceReadyDays,
      limitedHistory,
      reopened,
      updatedAt: new Date(),
    });
  }

  const chunk = 200;
  for (let i = 0; i < upserts.length; i += chunk) {
    await db
      .insert(projectMilestonesTable)
      .values(upserts.slice(i, i + chunk))
      .onConflictDoUpdate({
        target: projectMilestonesTable.project,
        set: {
          projectStart: sql`excluded.project_start`,
          readyDate: sql`excluded.ready_date`,
          readyImportId: sql`excluded.ready_import_id`,
          readyTurnaroundDays: sql`excluded.ready_turnaround_days`,
          dispatchedDate: sql`excluded.dispatched_date`,
          dispatchedImportId: sql`excluded.dispatched_import_id`,
          dispatchedTurnaroundDays: sql`excluded.dispatched_turnaround_days`,
          dispatchLagDays: sql`excluded.dispatch_lag_days`,
          marksTotal: sql`excluded.marks_total`,
          plannedReadyDays: sql`excluded.planned_ready_days`,
          varianceReadyDays: sql`excluded.variance_ready_days`,
          limitedHistory: sql`excluded.limited_history`,
          reopened: sql`excluded.reopened`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }

  items.sort((a, b) => a.project.localeCompare(b.project));
  return items;
}
