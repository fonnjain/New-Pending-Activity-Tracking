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
  // Most recent import (id + report date) in which the project was present.
  lastSeenImportId: number | null;
  lastSeenDate: string | null;
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
    lastSeenImportId: null,
    lastSeenDate: null,
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

  // Track the NEWEST import (max id = last in ascending order) and the projects
  // present in it. Used by the data-retention dispatch capture below so a project
  // absent from the newest report can be Dispatched even if the import that
  // established its presence was deleted.
  let latestImportId: number | null = null;
  let latestYmd: string | null = null;
  let latestPresent = new Set<string>();

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
      // Record the latest import in which this project was present (advances in
      // ascending id order). Persisted so it survives import deletion/pruning.
      st.lastSeenImportId = imp.id;
      st.lastSeenDate = ymd;
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

    // Newest import wins (ascending order): snapshot its present project set so
    // the data-retention dispatch capture can tell which projects are absent.
    latestImportId = imp.id;
    latestYmd = ymd;
    latestPresent = new Set(present.keys());
  }

  // Earliest Assign Date + distinct mark count per project across the whole
  // permanent pool. The mark count provides a marksTotal for orphan projects
  // (below) whose import history was deleted, so they don't display as "0 marks".
  const startRows = await db
    .select({
      job: recordPoolTable.job,
      start: sql<string | null>`min(${recordPoolTable.assignDate})`,
      marks: sql<number>`count(distinct coalesce(${recordPoolTable.markId}, '') || chr(1) || coalesce(${recordPoolTable.jobCardNo}, ''))`,
    })
    .from(recordPoolTable)
    .where(ne(recordPoolTable.job, UNASSIGNED))
    .groupBy(recordPoolTable.job);
  const startByJob = new Map<string, string | null>();
  const poolMarksByJob = new Map<string, number>();
  for (const s of startRows) {
    startByJob.set(s.job, s.start);
    poolMarksByJob.set(s.job, Number(s.marks) || 0);
  }

  // Capture-once merge: a stored milestone date always wins over a recomputed one
  // (they agree while history is intact; the stored value survives if history is
  // ever truncated).
  const existingRows = await db.select().from(projectMilestonesTable);
  const existing = new Map(existingRows.map((r) => [r.project, r]));

  const items: ProjectMilestone[] = [];
  const upserts: (typeof projectMilestonesTable.$inferInsert)[] = [];

  // Materialize over the UNION of replayed projects, already-stored milestone
  // rows, AND every project that still exists in the permanent record_pool, so a
  // completed project that no longer appears in the current import history (import
  // deleted/pruned, partial-history environment) is still returned and persisted
  // — honouring capture-once permanence. Seeding from the pool is what keeps an
  // orphaned completed project (its imports deleted before it was ever captured)
  // from vanishing from the Completed view.
  const allProjects = new Set<string>([
    ...states.keys(),
    ...existing.keys(),
    ...startByJob.keys(),
  ]);
  for (const project of allProjects) {
    const st = states.get(project);
    const ex = existing.get(project);
    const projectStart = startByJob.get(project) ?? ex?.projectStart ?? null;
    let readyDate = ex?.readyDate ?? st?.readyDate ?? null;
    let readyImportId = ex?.readyImportId ?? st?.readyImportId ?? null;
    let dispatchedDate = ex?.dispatchedDate ?? st?.dispatchedDate ?? null;
    let dispatchedImportId =
      ex?.dispatchedImportId ?? st?.dispatchedImportId ?? null;
    // An orphan (in the pool, but with no walk state and no stored milestone)
    // has no identity set or stored count, so fall back to the pool mark count.
    const marksTotal = Math.max(
      st?.identities.size ?? 0,
      ex?.marksTotal ?? 0,
      !st && !ex ? (poolMarksByJob.get(project) ?? 0) : 0,
    );
    const reopened = (st?.reopened ?? false) || (ex?.reopened ?? false);
    let limitedHistory = ex?.limitedHistory ?? st?.limitedHistory ?? false;

    // Merge last-seen presence: keep the GREATER import id (advance forward only)
    // so a deleted/pruned import can never roll it backward. This is what makes
    // dispatch-on-disappear survive deletion of the import that established the
    // project's presence.
    const stLastSeenId = st?.lastSeenImportId ?? null;
    const exLastSeenId = ex?.lastSeenImportId ?? null;
    let lastSeenImportId: number | null;
    let lastSeenDate: string | null;
    if (
      stLastSeenId !== null &&
      (exLastSeenId === null || stLastSeenId >= exLastSeenId)
    ) {
      lastSeenImportId = stLastSeenId;
      lastSeenDate = st?.lastSeenDate ?? null;
    } else {
      lastSeenImportId = exLastSeenId;
      lastSeenDate = ex?.lastSeenDate ?? null;
    }

    // Data-retention dispatch capture: a project with a known last-seen presence
    // that PREDATES the newest report and is absent from it is Dispatched — even
    // if the import that established its presence has since been deleted (so the
    // replay-based capture above never fired). Dated from the newest report.
    // Honours capture-once: only fills a still-null dispatch, never moves one.
    if (
      dispatchedDate === null &&
      lastSeenImportId !== null &&
      latestImportId !== null &&
      lastSeenImportId < latestImportId &&
      !latestPresent.has(project)
    ) {
      dispatchedDate = latestYmd;
      dispatchedImportId = latestImportId;
      // Straight-to-gone: never observed all-in-yard, stamp Ready too (lag 0).
      if (readyDate === null) {
        readyDate = latestYmd;
        readyImportId = latestImportId;
        if (!(st?.inProgressObserved ?? false)) limitedHistory = true;
      }
    }

    // Orphan retention: a completed project that survives only in the permanent
    // record_pool — every import that referenced it has since been deleted, so
    // the replay walk never saw it (no `st`) and no milestone was ever stored
    // (no `ex`). It cannot be in any current import (or it would have a walk
    // state), so it is by definition Dispatched. Keep it permanently rather than
    // dropping it from Completed, stamped from the newest report with limited
    // history. Once persisted it flows through the capture-once `ex` branch and
    // its dates never move again.
    if (!st && !ex && dispatchedDate === null && latestYmd !== null) {
      dispatchedDate = latestYmd;
      dispatchedImportId = latestImportId;
      if (readyDate === null) {
        readyDate = latestYmd;
        readyImportId = latestImportId;
      }
      limitedHistory = true;
    }

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
      lastSeenImportId,
      lastSeenDate,
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
          lastSeenImportId: sql`excluded.last_seen_import_id`,
          lastSeenDate: sql`excluded.last_seen_date`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }

  items.sort((a, b) => a.project.localeCompare(b.project));
  return items;
}
