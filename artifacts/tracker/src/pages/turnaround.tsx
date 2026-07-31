import { Fragment, useMemo, useState } from "react";
import { useTracker, useFilteredRecords } from "@/lib/store";
import {
  useGetImportRecords,
  getGetImportRecordsQueryKey,
  type Record as ApiRecord,
} from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { formatWeight, formatDate } from "@/lib/utils";
import { useSettings } from "@/lib/settings";
import {
  lifecycleStatus,
  migrateTurnaroundSettings,
  compareActivity,
  scopeFor,
  activityDisplayKey,
  sequenceFor,
  type LifecycleResult,
} from "@workspace/domain";
import { LIFECYCLE_LABELS, lifecycleBgColor, lifecycleTextColor } from "@/lib/turnaround";
import { TurnaroundWarnings } from "@/components/turnaround-warnings";
import { AiTurnaroundReport } from "@/components/ai-turnaround-report";
import { EmptyState } from "./overview";
import { ProjectCompletionBanner } from "@/components/project-completion-banner";
import { SlidersHorizontal, Clock, ChevronRight, FileSpreadsheet } from "lucide-react";
import { exportToXlsxSheets, type XlsxSheet } from "@/lib/export";

export default function TurnaroundView() {
  const { selectedImportId } = useTracker();
  if (!selectedImportId) return <EmptyState />;
  return <TurnaroundContent importId={selectedImportId} />;
}

function TurnaroundContent({ importId }: { importId: number }) {
  const { data: allRecords } = useGetImportRecords(importId, {
    query: { enabled: true, queryKey: getGetImportRecordsQueryKey(importId) },
  });
  const rawRecords = useFilteredRecords(allRecords);

  // Apply the Client MFC Date override once here so every sub-component —
  // TurnaroundBreakdown, TurnaroundWarnings, and UrgencyWorklist — shares the
  // same ageing baseline without duplicating the logic. When a mark's project
  // has a clientMfcDate, ageingDays is replaced with today − dateOfClientMfc
  // (total elapsed days since the client committed the MFC). Marks whose
  // project has no date are passed through unchanged.
  const records = useMemo(() => {
    const todayMs = Date.now();
    return rawRecords.map((r) => {
      if (!r.clientMfcDate) return r;
      const mfcMs = Date.parse(`${r.clientMfcDate}T00:00:00Z`);
      if (!Number.isFinite(mfcMs)) return r;
      return { ...r, ageingDays: Math.max(0, Math.floor((todayMs - mfcMs) / 86_400_000)) };
    });
  }, [rawRecords]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Clock className="w-5 h-5 text-primary" /> Turnaround
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Deep dive into how marks are tracking against their cumulative
            targets. Advisory and display-only — never changes ageing, activity,
            or thresholds.
          </p>
        </div>
        <Link href="/warning-parameters">
          <Button variant="outline" size="sm" className="h-8 gap-2">
            <SlidersHorizontal className="h-4 w-4" />
            Warning Parameters
          </Button>
        </Link>
      </div>

      <ProjectCompletionBanner />
      <TurnaroundBreakdown records={records} />
      <TurnaroundWarnings records={records} />
      <UrgencyWorklist records={records} />
      <AiTurnaroundReport />
    </div>
  );
}

// Per-record lifecycle classification rolled up by project / contractor / stage,
// mirroring the Stuck Projects breakdown but driven by turnaround (overrun)
// metrics instead of velocity. Advisory only — never changes ageing/thresholds.
type Bucket = {
  markCount: number;
  breached: number;
  prewarn: number;
  overrunSum: number;
  overrunCount: number;
};

function newBucket(): Bucket {
  return { markCount: 0, breached: 0, prewarn: 0, overrunSum: 0, overrunCount: 0 };
}

function tally(b: Bucket, res: LifecycleResult) {
  b.markCount++;
  if (res.status.startsWith("breach")) b.breached++;
  else if (res.status.startsWith("prewarn")) b.prewarn++;
  if (res.overrun !== null && res.overrun > 0) {
    b.overrunSum += res.overrun;
    b.overrunCount++;
  }
}

function avgOverrun(b: Bucket): number | null {
  return b.overrunCount ? Math.round(b.overrunSum / b.overrunCount) : null;
}

function breachScore(b: Bucket): number {
  return b.markCount ? (b.breached + 0.5 * b.prewarn) / b.markCount : 0;
}

type View = "projects" | "contractors" | "stages";

const VIEW_OPTIONS: { id: View; name: string }[] = [
  { id: "projects", name: "Projects" },
  { id: "contractors", name: "Contractors" },
  { id: "stages", name: "Stages" },
];

function TurnaroundBreakdown({ records }: { records: ApiRecord[] }) {
  const { settings: rawSettings } = useSettings();
  const settings = useMemo(
    () => migrateTurnaroundSettings(rawSettings),
    [rawSettings],
  );
  const [view, setView] = useState<View>("projects");
  const [openProject, setOpenProject] = useState<string | null>(null);
  const [openContractor, setOpenContractor] = useState<string | null>(null);
  const [openStage, setOpenStage] = useState<string | null>(null);

  // Classify every visible record once, then derive each rollup from it so the
  // tabs always honour the active header filters. Records already have their
  // ageingDays overridden at the TurnaroundContent level (clientMfcDate → today
  // − dateOfClientMfc when set), so no further adjustment is needed here.
  const classified = useMemo(
    () =>
      records.map((r) => ({
        r,
        res: lifecycleStatus(
          { activity: r.activity, ageingDays: r.ageingDays, scope: scopeFor(r), sequence: sequenceFor(r) },
          settings,
        ),
      })),
    [records, settings],
  );

  const projects = useMemo(() => {
    const map = new Map<string, Bucket>();
    for (const { r, res } of classified) {
      const key = r.job || "(Unassigned)";
      const b = map.get(key) ?? newBucket();
      tally(b, res);
      map.set(key, b);
    }
    return [...map.entries()]
      .map(([project, b]) => ({
        project,
        markCount: b.markCount,
        breached: b.breached,
        prewarn: b.prewarn,
        avgOverrun: avgOverrun(b),
        score: breachScore(b),
      }))
      .sort((a, b) => b.score - a.score || b.breached - a.breached);
  }, [classified]);

  const contractors = useMemo(() => {
    const map = new Map<string, Bucket>();
    for (const { r, res } of classified) {
      const key = r.contractor || "Unassigned";
      const b = map.get(key) ?? newBucket();
      tally(b, res);
      map.set(key, b);
    }
    return [...map.entries()]
      .map(([contractor, b]) => ({
        contractor,
        markCount: b.markCount,
        breached: b.breached,
        prewarn: b.prewarn,
        avgOverrun: avgOverrun(b),
        score: breachScore(b),
      }))
      .sort((a, b) => b.score - a.score || b.breached - a.breached);
  }, [classified]);

  const stages = useMemo(() => {
    const map = new Map<string, Bucket>();
    for (const { r, res } of classified) {
      const key = activityDisplayKey(r.activity, r.category);
      const b = map.get(key) ?? newBucket();
      tally(b, res);
      map.set(key, b);
    }
    return [...map.entries()]
      .map(([activity, b]) => ({
        activity,
        markCount: b.markCount,
        breached: b.breached,
        prewarn: b.prewarn,
        avgOverrun: avgOverrun(b),
      }))
      .sort((a, b) => compareActivity(a.activity, b.activity));
  }, [classified]);

  const handleExport = () => {
    const sheets: XlsxSheet[] = [
      {
        name: "Projects",
        columns: [
          { label: "Project", field: "project" },
          { label: "Marks", field: "markCount", numeric: true, decimals: 0, total: true },
          { label: "Breached", field: "breached", numeric: true, decimals: 0, total: true },
          { label: "Pre-warn", field: "prewarn", numeric: true, decimals: 0, total: true },
          { label: "Avg Overrun", field: "avgOverrun", numeric: true, decimals: 1 },
          { label: "Score", field: "score", numeric: true, decimals: 2 },
        ],
        rows: projects,
      },
      {
        name: "Contractors",
        columns: [
          { label: "Contractor", field: "contractor" },
          { label: "Marks", field: "markCount", numeric: true, decimals: 0, total: true },
          { label: "Breached", field: "breached", numeric: true, decimals: 0, total: true },
          { label: "Pre-warn", field: "prewarn", numeric: true, decimals: 0, total: true },
          { label: "Avg Overrun", field: "avgOverrun", numeric: true, decimals: 1 },
          { label: "Score", field: "score", numeric: true, decimals: 2 },
        ],
        rows: contractors,
      },
      {
        name: "Stages",
        columns: [
          { label: "Activity", field: "activity" },
          { label: "Marks", field: "markCount", numeric: true, decimals: 0, total: true },
          { label: "Breached", field: "breached", numeric: true, decimals: 0, total: true },
          { label: "Pre-warn", field: "prewarn", numeric: true, decimals: 0, total: true },
          { label: "Avg Overrun", field: "avgOverrun", numeric: true, decimals: 1 },
        ],
        rows: stages,
      },
    ];
    void exportToXlsxSheets(
      `turnaround_${new Date().toISOString().slice(0, 10)}.xlsx`,
      sheets,
    ).catch((err) => console.error("[Export] turnaround failed", err));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {VIEW_OPTIONS.map((o) => (
            <button
              key={o.id}
              onClick={() => setView(o.id)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                view === o.id
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/70"
              }`}
            >
              {o.name}
            </button>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-2"
          onClick={handleExport}
          disabled={projects.length === 0}
        >
          <FileSpreadsheet className="h-4 w-4" /> Export Excel
        </Button>
      </div>

      {view === "projects" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">
              Project Leaderboard
            </CardTitle>
          </CardHeader>
          <CardContent>
            {projects.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                No records for the selected filters.
              </div>
            ) : (
              <div className="space-y-1">
                {projects.map((p) => (
                  <div key={p.project} className="rounded-md border border-border">
                    <button
                      className="w-full flex items-center gap-3 p-2 text-left hover:bg-muted/30"
                      onClick={() =>
                        setOpenProject(openProject === p.project ? null : p.project)
                      }
                    >
                      <span className="font-mono font-medium w-24 shrink-0 truncate">{p.project}</span>
                      <div className="flex h-3 flex-1 rounded-sm overflow-hidden min-w-[80px] bg-muted">
                        <div
                          className="bg-ageing-red"
                          style={{ width: `${(p.breached / p.markCount) * 100}%` }}
                          title={`Breached: ${p.breached}`}
                        />
                        <div
                          className="bg-amber-500"
                          style={{ width: `${(p.prewarn / p.markCount) * 100}%` }}
                          title={`Pre-warning: ${p.prewarn}`}
                        />
                      </div>
                      <span className="text-xs tabular-nums w-36 text-right shrink-0 text-muted-foreground">
                        {p.breached} breached · {p.prewarn} pre-warn
                      </span>
                      <span className="text-sm font-bold tabular-nums w-14 text-right shrink-0">
                        {Math.round(p.score * 100)}%
                      </span>
                    </button>
                    {openProject === p.project && (
                      <MarkDrill
                        items={classified.filter(({ r }) => (r.job || "(Unassigned)") === p.project)}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {view === "contractors" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">
              Overrun by Contractor
            </CardTitle>
          </CardHeader>
          <CardContent>
            {contractors.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                No records for the selected filters.
              </div>
            ) : (
              <div className="overflow-auto max-h-[70vh]">
                <table className="w-full text-sm">
                  <thead className="bg-card sticky top-0 z-10">
                    <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
                      <th className="py-1.5 pr-3 font-medium">Contractor</th>
                      <th className="py-1.5 pr-3 font-medium text-right">Marks</th>
                      <th className="py-1.5 pr-3 font-medium text-right">Breached</th>
                      <th className="py-1.5 pr-3 font-medium text-right">Pre-warn</th>
                      <th className="py-1.5 pr-3 font-medium text-right">Avg Overrun</th>
                      <th className="py-1.5 font-medium text-right">Breach</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contractors.slice(0, 50).map((c) => (
                      <Fragment key={c.contractor}>
                        <tr
                          className="border-b border-border/50 hover:bg-muted/30 cursor-pointer focus:outline-none focus-visible:bg-muted/50"
                          role="button"
                          tabIndex={0}
                          aria-expanded={openContractor === c.contractor}
                          onClick={() =>
                            setOpenContractor(openContractor === c.contractor ? null : c.contractor)
                          }
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setOpenContractor(openContractor === c.contractor ? null : c.contractor);
                            }
                          }}
                        >
                          <td className="py-1.5 pr-3">
                            <span className="inline-flex items-center gap-1.5">
                              <ChevronRight
                                className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${openContractor === c.contractor ? "rotate-90" : ""}`}
                              />
                              {c.contractor}
                            </span>
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{c.markCount}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums text-ageing-red font-semibold">
                            {c.breached || ""}
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums text-amber-600 font-semibold">
                            {c.prewarn || ""}
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">
                            {c.avgOverrun !== null ? `+${c.avgOverrun}d` : "-"}
                          </td>
                          <td className="py-1.5 text-right tabular-nums font-bold">
                            {Math.round(c.score * 100)}%
                          </td>
                        </tr>
                        {openContractor === c.contractor && (
                          <tr>
                            <td colSpan={6} className="p-0">
                              <MarkDrill
                                items={classified.filter(
                                  ({ r }) => (r.contractor || "Unassigned") === c.contractor,
                                )}
                              />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
                {contractors.length > 50 && (
                  <div className="text-xs text-muted-foreground mt-2">
                    Showing top 50 of {contractors.length}.
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {view === "stages" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">
              Overrun by Stage
            </CardTitle>
          </CardHeader>
          <CardContent>
            {stages.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                No records for the selected filters.
              </div>
            ) : (
              <div className="overflow-auto max-h-[70vh]">
                <table className="w-full text-sm">
                  <thead className="bg-card sticky top-0 z-10">
                    <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
                      <th className="py-1.5 pr-3 font-medium">Stage</th>
                      <th className="py-1.5 pr-3 font-medium text-right">Marks</th>
                      <th className="py-1.5 pr-3 font-medium text-right">Breached</th>
                      <th className="py-1.5 pr-3 font-medium text-right">Pre-warn</th>
                      <th className="py-1.5 font-medium text-right">Avg Overrun</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stages.map((s) => (
                      <Fragment key={s.activity}>
                        <tr
                          className="border-b border-border/50 hover:bg-muted/30 cursor-pointer focus:outline-none focus-visible:bg-muted/50"
                          role="button"
                          tabIndex={0}
                          aria-expanded={openStage === s.activity}
                          onClick={() =>
                            setOpenStage(openStage === s.activity ? null : s.activity)
                          }
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setOpenStage(openStage === s.activity ? null : s.activity);
                            }
                          }}
                        >
                          <td className="py-1.5 pr-3 font-mono">
                            <span className="inline-flex items-center gap-1.5">
                              <ChevronRight
                                className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${openStage === s.activity ? "rotate-90" : ""}`}
                              />
                              {s.activity}
                            </span>
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{s.markCount}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums text-ageing-red font-semibold">
                            {s.breached || ""}
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums text-amber-600 font-semibold">
                            {s.prewarn || ""}
                          </td>
                          <td className="py-1.5 text-right tabular-nums">
                            {s.avgOverrun !== null ? `+${s.avgOverrun}d` : "-"}
                          </td>
                        </tr>
                        {openStage === s.activity && (
                          <tr>
                            <td colSpan={5} className="p-0">
                              <MarkDrill
                                items={classified.filter(
                                  ({ r }) => (r.activity || "—") === s.activity,
                                )}
                              />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// Drill into one project's marks, worst lifecycle state first.
function MarkDrill({
  items,
}: {
  items: Array<{ r: ApiRecord; res: LifecycleResult }>;
}) {
  const sorted = useMemo(() => {
    const rank = (s: string) =>
      s.startsWith("breach") ? 0 : s.startsWith("prewarn") ? 1 : s === "green" ? 2 : 3;
    return [...items].sort(
      (a, b) =>
        rank(a.res.status) - rank(b.res.status) ||
        (b.res.overrun ?? -Infinity) - (a.res.overrun ?? -Infinity),
    );
  }, [items]);

  return (
    <div className="border-t border-border overflow-auto max-h-[70vh]">
      <table className="w-full text-sm">
        <thead className="bg-card sticky top-0 z-10">
          <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground border-b border-border bg-muted/30">
            <th className="py-1.5 px-3 font-medium">Mark</th>
            <th className="py-1.5 pr-3 font-medium">Activity</th>
            <th className="py-1.5 pr-3 font-medium">Status</th>
            <th className="py-1.5 pr-3 font-medium text-right">Ageing</th>
            <th className="py-1.5 pr-3 font-medium text-right">Target</th>
            <th className="py-1.5 pr-3 font-medium text-right">Overrun</th>
            <th className="py-1.5 pr-3 font-medium">Contractor</th>
            <th className="py-1.5 pr-3 font-medium text-right">Wt</th>
          </tr>
        </thead>
        <tbody>
          {sorted.slice(0, 100).map(({ r, res }) => (
            <tr key={r.id} className="border-b border-border/50">
              <td className="py-1.5 px-3 font-mono">{r.markId}</td>
              <td className="py-1.5 pr-3 font-mono">{r.activity}</td>
              <td className="py-1.5 pr-3">
                <span className="inline-flex items-center gap-1.5">
                  <span className={`w-2 h-2 rounded-full ${lifecycleBgColor(res.status)}`} />
                  <span className={`text-xs font-semibold ${lifecycleTextColor(res.status)}`}>
                    {LIFECYCLE_LABELS[res.status]}
                  </span>
                </span>
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums">
                <div className="inline-flex flex-col items-end gap-0.5">
                  <span>{r.ageingDays !== null ? `${r.ageingDays}d` : "-"}</span>
                  {r.clientMfcDate && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 rounded px-1 py-0.5 whitespace-nowrap">
                      📅 MFC: {formatDate(r.clientMfcDate)}
                    </span>
                  )}
                </div>
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
                {res.target !== null ? `${res.target}d` : "-"}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums font-semibold">
                {res.overrun !== null && res.overrun > 0 ? `+${res.overrun}d` : "-"}
              </td>
              <td className="py-1.5 pr-3">{r.contractor || "Unassigned"}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{formatWeight(r.balanceWt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length > 100 && (
        <div className="text-xs text-muted-foreground p-2">Showing top 100 of {sorted.length}.</div>
      )}
    </div>
  );
}

// Marks within target, ordered by days-to-target ascending — the soonest to
// breach come first. Excludes already-breached (those are in TurnaroundWarnings)
// and n/a marks.
function UrgencyWorklist({ records }: { records: ApiRecord[] }) {
  const { settings: rawSettings } = useSettings();
  const settings = useMemo(
    () => migrateTurnaroundSettings(rawSettings),
    [rawSettings],
  );

  const items = useMemo(() => {
    const out: Array<{ r: ApiRecord; res: LifecycleResult }> = [];
    for (const r of records) {
      const res = lifecycleStatus(
        { activity: r.activity, ageingDays: r.ageingDays, scope: scopeFor(r), sequence: sequenceFor(r) },
        settings,
      );
      if (res.status === "na" || res.status.startsWith("breach")) continue;
      if (res.daysToTarget === null) continue;
      out.push({ r, res });
    }
    out.sort((a, b) => (a.res.daysToTarget ?? Infinity) - (b.res.daysToTarget ?? Infinity));
    return out;
  }, [records, settings]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">
          Closest to Target ({items.length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No within-target marks with a defined target for the current filters.
          </div>
        ) : (
          <div className="overflow-auto max-h-[70vh]">
            <table className="w-full text-sm">
              <thead className="bg-card sticky top-0 z-10">
                <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
                  <th className="py-1.5 pr-3 font-medium">Mark</th>
                  <th className="py-1.5 pr-3 font-medium">Activity</th>
                  <th className="py-1.5 pr-3 font-medium">Status</th>
                  <th className="py-1.5 pr-3 font-medium text-right">Ageing</th>
                  <th className="py-1.5 pr-3 font-medium text-right">Target</th>
                  <th className="py-1.5 pr-3 font-medium text-right">To Target</th>
                  <th className="py-1.5 pr-3 font-medium">Contractor</th>
                  <th className="py-1.5 font-medium text-right">Wt</th>
                </tr>
              </thead>
              <tbody>
                {items.slice(0, 100).map(({ r, res }) => (
                  <tr key={r.id} className="border-b border-border/50 hover:bg-muted/30">
                    <td className="py-1.5 pr-3 font-mono">{r.markId}</td>
                    <td className="py-1.5 pr-3 font-mono">{r.activity}</td>
                    <td className="py-1.5 pr-3">
                      <span className="inline-flex items-center gap-1.5">
                        <span className={`w-2 h-2 rounded-full ${lifecycleBgColor(res.status)}`} />
                        <span className={`text-xs font-semibold ${lifecycleTextColor(res.status)}`}>
                          {LIFECYCLE_LABELS[res.status]}
                        </span>
                      </span>
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      <div className="inline-flex flex-col items-end gap-0.5">
                        <span>{r.ageingDays !== null ? `${r.ageingDays}d` : "-"}</span>
                        {r.clientMfcDate && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 rounded px-1 py-0.5 whitespace-nowrap">
                            📅 MFC: {formatDate(r.clientMfcDate)}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
                      {res.target !== null ? `${res.target}d` : "-"}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums font-semibold">
                      {res.daysToTarget !== null ? `${res.daysToTarget}d` : "-"}
                    </td>
                    <td className="py-1.5 pr-3">{r.contractor || "Unassigned"}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatWeight(r.balanceWt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {items.length > 100 && (
              <div className="text-xs text-muted-foreground mt-2">
                Showing closest 100 of {items.length}.
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
