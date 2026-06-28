import { Fragment, useMemo, useState } from "react";
import { useTracker, useFilteredRecords } from "@/lib/store";
import {
  useGetImportRecords,
  getGetImportRecordsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  useVelocityInfo,
  velocityKey,
  VELOCITY_LABELS,
  velocityStatusColor,
  velocityStatusBg,
  TREND_LABELS,
  trendArrow,
  fmtDays,
} from "@/lib/velocity";
import { compareActivity } from "@workspace/domain";
import { EmptyState } from "./overview";
import { AlertTriangle, ChevronRight, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { exportToXlsxSheets, type XlsxSheet } from "@/lib/export";

type View = "projects" | "contractors" | "stages";

const VIEW_OPTIONS: { id: View; name: string }[] = [
  { id: "projects", name: "Projects" },
  { id: "contractors", name: "Contractors" },
  { id: "stages", name: "Stages" },
];

export default function StuckProjectsView() {
  const { selectedImportId } = useTracker();
  if (!selectedImportId) return <EmptyState />;
  return <StuckContent importId={selectedImportId} />;
}

function StuckContent({ importId }: { importId: number }) {
  const { data: allRecords } = useGetImportRecords(importId, {
    query: { enabled: true, queryKey: getGetImportRecordsQueryKey(importId) },
  });
  const records = useFilteredRecords(allRecords);
  const velocity = useVelocityInfo(importId);
  const [view, setView] = useState<View>("projects");
  const [openProject, setOpenProject] = useState<string | null>(null);
  const [openContractor, setOpenContractor] = useState<string | null>(null);
  const [openStage, setOpenStage] = useState<string | null>(null);

  // Restrict velocity items to the marks visible under the active header
  // filters so the leaderboard always matches what the rest of the app shows.
  const visibleKeys = useMemo(() => {
    const set = new Set<string>();
    for (const r of records) set.add(velocityKey(r.markId, r.jobCardNo));
    return set;
  }, [records]);

  const items = useMemo(
    () => velocity.items.filter((v) => visibleKeys.has(velocityKey(v.markId, v.jobCardNo))),
    [velocity.items, visibleKeys],
  );

  // Recompute project / contractor / stage rollups from the filtered items so
  // they respect the header filters (the endpoint aggregates the full import).
  const projects = useMemo(() => {
    const map = new Map<
      string,
      { markCount: number; stalled: number; slow: number; gapSum: number; gapCount: number }
    >();
    for (const v of items) {
      const g = map.get(v.job) ?? { markCount: 0, stalled: 0, slow: 0, gapSum: 0, gapCount: 0 };
      g.markCount++;
      if (v.status === "stalled") g.stalled++;
      else if (v.status === "slow") g.slow++;
      if (v.etaGap !== null) {
        g.gapSum += v.etaGap;
        g.gapCount++;
      }
      map.set(v.job, g);
    }
    return [...map.entries()]
      .map(([project, g]) => ({
        project,
        markCount: g.markCount,
        stalled: g.stalled,
        slow: g.slow,
        avgEtaGap: g.gapCount ? g.gapSum / g.gapCount : null,
        stuckScore: g.markCount ? (g.stalled + 0.5 * g.slow) / g.markCount : 0,
      }))
      .sort((a, b) => b.stuckScore - a.stuckScore || b.stalled - a.stalled);
  }, [items]);

  const contractors = useMemo(() => {
    const map = new Map<
      string,
      { markCount: number; stalled: number; slow: number; gapSum: number; gapCount: number }
    >();
    for (const v of items) {
      const key = v.contractor || "Unassigned";
      const g = map.get(key) ?? { markCount: 0, stalled: 0, slow: 0, gapSum: 0, gapCount: 0 };
      g.markCount++;
      if (v.status === "stalled") g.stalled++;
      else if (v.status === "slow") g.slow++;
      if (v.etaGap !== null) {
        g.gapSum += v.etaGap;
        g.gapCount++;
      }
      map.set(key, g);
    }
    return [...map.entries()]
      .map(([contractor, g]) => ({
        contractor,
        markCount: g.markCount,
        stalled: g.stalled,
        slow: g.slow,
        avgEtaGap: g.gapCount ? g.gapSum / g.gapCount : null,
        stuckScore: g.markCount ? (g.stalled + 0.5 * g.slow) / g.markCount : 0,
      }))
      .sort((a, b) => b.stuckScore - a.stuckScore || b.stalled - a.stalled);
  }, [items]);

  const stages = useMemo(() => {
    const map = new Map<
      string,
      { markCount: number; stalled: number; slow: number; paceSum: number; paceCount: number }
    >();
    for (const v of items) {
      const key = v.activity || "—";
      const g = map.get(key) ?? { markCount: 0, stalled: 0, slow: 0, paceSum: 0, paceCount: 0 };
      g.markCount++;
      if (v.status === "stalled") g.stalled++;
      else if (v.status === "slow") g.slow++;
      if (v.daysPerStage !== null) {
        g.paceSum += v.daysPerStage;
        g.paceCount++;
      }
      map.set(key, g);
    }
    return [...map.entries()]
      .map(([activity, g]) => ({
        activity,
        markCount: g.markCount,
        stalled: g.stalled,
        slow: g.slow,
        avgDaysPerStage: g.paceCount ? g.paceSum / g.paceCount : null,
      }))
      .sort((a, b) => compareActivity(a.activity, b.activity));
  }, [items]);

  const totalStalled = items.filter((v) => v.status === "stalled").length;
  const totalSlow = items.filter((v) => v.status === "slow").length;
  const totalMoving = items.filter((v) => v.status === "moving").length;
  const totalInsufficient = items.filter((v) => v.status === "insufficient").length;

  const handleExport = () => {
    const sheets: XlsxSheet[] = [
      {
        name: "Projects",
        columns: [
          { label: "Project", field: "project" },
          { label: "Marks", field: "markCount", numeric: true, decimals: 0, total: true },
          { label: "Stalled", field: "stalled", numeric: true, decimals: 0, total: true },
          { label: "Slow", field: "slow", numeric: true, decimals: 0, total: true },
          { label: "Avg ETA Gap", field: "avgEtaGap", numeric: true, decimals: 1 },
          { label: "Stuck Score", field: "stuckScore", numeric: true, decimals: 2 },
        ],
        rows: projects,
      },
      {
        name: "Contractors",
        columns: [
          { label: "Contractor", field: "contractor" },
          { label: "Marks", field: "markCount", numeric: true, decimals: 0, total: true },
          { label: "Stalled", field: "stalled", numeric: true, decimals: 0, total: true },
          { label: "Slow", field: "slow", numeric: true, decimals: 0, total: true },
          { label: "Avg ETA Gap", field: "avgEtaGap", numeric: true, decimals: 1 },
          { label: "Stuck Score", field: "stuckScore", numeric: true, decimals: 2 },
        ],
        rows: contractors,
      },
      {
        name: "Stages",
        columns: [
          { label: "Activity", field: "activity" },
          { label: "Marks", field: "markCount", numeric: true, decimals: 0, total: true },
          { label: "Stalled", field: "stalled", numeric: true, decimals: 0, total: true },
          { label: "Slow", field: "slow", numeric: true, decimals: 0, total: true },
          { label: "Avg Days/Stage", field: "avgDaysPerStage", numeric: true, decimals: 1 },
        ],
        rows: stages,
      },
    ];
    void exportToXlsxSheets(
      `stuck_projects_${new Date().toISOString().slice(0, 10)}.xlsx`,
      sheets,
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-ageing-red" /> Stuck Projects
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Pace, projected ETA and movement across snapshot history. Deterministic
          and advisory — never changes ageing, activity, or thresholds.
        </p>
      </div>

      {!velocity.hasHistory && (
        <Card className="border-border">
          <CardContent className="py-4 text-sm text-muted-foreground">
            Velocity needs at least one earlier import to compare against. Upload
            another report to unlock pace, ETA and trend.
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryTile label="Stalled" value={totalStalled} cls="bg-red-500" />
        <SummaryTile label="Slow" value={totalSlow} cls="bg-amber-500" />
        <SummaryTile label="Moving" value={totalMoving} cls="bg-emerald-500" />
        <SummaryTile label="No history" value={totalInsufficient} cls="bg-slate-300" />
      </div>

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
              <div className="text-sm text-muted-foreground">No velocity data for the current filters.</div>
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
                          className="bg-red-500"
                          style={{ width: `${(p.stalled / p.markCount) * 100}%` }}
                          title={`Stalled: ${p.stalled}`}
                        />
                        <div
                          className="bg-amber-500"
                          style={{ width: `${(p.slow / p.markCount) * 100}%` }}
                          title={`Slow: ${p.slow}`}
                        />
                      </div>
                      <span className="text-xs tabular-nums w-32 text-right shrink-0 text-muted-foreground">
                        {p.stalled} stalled · {p.slow} slow
                      </span>
                      <span className="text-sm font-bold tabular-nums w-14 text-right shrink-0">
                        {Math.round(p.stuckScore * 100)}%
                      </span>
                    </button>
                    {openProject === p.project && (
                      <MarkDrill
                        items={items.filter((v) => v.job === p.project)}
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
              Contractor Velocity
            </CardTitle>
          </CardHeader>
          <CardContent>
            {contractors.length === 0 ? (
              <div className="text-sm text-muted-foreground">No velocity data for the current filters.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
                      <th className="py-1.5 pr-3 font-medium">Contractor</th>
                      <th className="py-1.5 pr-3 font-medium text-right">Marks</th>
                      <th className="py-1.5 pr-3 font-medium text-right">Stalled</th>
                      <th className="py-1.5 pr-3 font-medium text-right">Slow</th>
                      <th className="py-1.5 pr-3 font-medium text-right">Avg ETA Gap</th>
                      <th className="py-1.5 font-medium text-right">Stuck</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contractors.map((c) => (
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
                          <td className="py-1.5 pr-3 text-right tabular-nums text-red-600 font-semibold">
                            {c.stalled || ""}
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums text-amber-600 font-semibold">
                            {c.slow || ""}
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
                            {c.avgEtaGap !== null
                              ? `${c.avgEtaGap > 0 ? "+" : ""}${fmtDays(c.avgEtaGap)}`
                              : "-"}
                          </td>
                          <td className="py-1.5 text-right tabular-nums font-bold">
                            {Math.round(c.stuckScore * 100)}%
                          </td>
                        </tr>
                        {openContractor === c.contractor && (
                          <tr>
                            <td colSpan={6} className="p-0">
                              <MarkDrill
                                items={items.filter(
                                  (v) => (v.contractor || "Unassigned") === c.contractor,
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

      {view === "stages" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">
              Stage Velocity
            </CardTitle>
          </CardHeader>
          <CardContent>
            {stages.length === 0 ? (
              <div className="text-sm text-muted-foreground">No velocity data for the current filters.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
                      <th className="py-1.5 pr-3 font-medium">Stage</th>
                      <th className="py-1.5 pr-3 font-medium text-right">Marks</th>
                      <th className="py-1.5 pr-3 font-medium text-right">Stalled</th>
                      <th className="py-1.5 pr-3 font-medium text-right">Slow</th>
                      <th className="py-1.5 font-medium text-right">Avg Days/Stage</th>
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
                          <td className="py-1.5 pr-3 text-right tabular-nums text-red-600 font-semibold">
                            {s.stalled || ""}
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums text-amber-600 font-semibold">
                            {s.slow || ""}
                          </td>
                          <td className="py-1.5 text-right tabular-nums">
                            {fmtDays(s.avgDaysPerStage)}
                          </td>
                        </tr>
                        {openStage === s.activity && (
                          <tr>
                            <td colSpan={5} className="p-0">
                              <MarkDrill
                                items={items.filter((v) => (v.activity || "—") === s.activity)}
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

function SummaryTile({ label, value, cls }: { label: string; value: number; cls: string }) {
  return (
    <Card className="shadow-sm">
      <CardContent className="p-4 flex flex-col items-center justify-center text-center">
        <div className="flex items-center gap-1.5 mb-1">
          <span className={`w-3 h-3 rounded-sm ${cls}`} />
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
        </div>
        <span className="text-sm sm:text-base font-medium tabular-nums">{value}</span>
      </CardContent>
    </Card>
  );
}

// Drill into the stalled/slow marks for one project, worst first.
function MarkDrill({ items }: { items: ReturnType<typeof useVelocityInfo>["items"] }) {
  const sorted = useMemo(() => {
    const rank = (s: string) => (s === "stalled" ? 0 : s === "slow" ? 1 : s === "moving" ? 2 : 3);
    return [...items].sort(
      (a, b) =>
        rank(a.status) - rank(b.status) ||
        (b.etaGap ?? -Infinity) - (a.etaGap ?? -Infinity),
    );
  }, [items]);

  return (
    <div className="border-t border-border overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground border-b border-border bg-muted/30">
            <th className="py-1.5 px-3 font-medium">Mark</th>
            <th className="py-1.5 pr-3 font-medium">Activity</th>
            <th className="py-1.5 pr-3 font-medium">Velocity</th>
            <th className="py-1.5 pr-3 font-medium text-right">Days/Stage</th>
            <th className="py-1.5 pr-3 font-medium text-right">ETA</th>
            <th className="py-1.5 pr-3 font-medium text-right">ETA Gap</th>
            <th className="py-1.5 pr-3 font-medium">Trend</th>
            <th className="py-1.5 pr-3 font-medium text-right">No Move</th>
          </tr>
        </thead>
        <tbody>
          {sorted.slice(0, 100).map((v) => (
            <tr key={velocityKey(v.markId, v.jobCardNo)} className="border-b border-border/50">
              <td className="py-1.5 px-3 font-mono">{v.markId}</td>
              <td className="py-1.5 pr-3 font-mono">{v.activity}</td>
              <td className="py-1.5 pr-3">
                <span className="inline-flex items-center gap-1.5">
                  <span className={`w-2 h-2 rounded-full ${velocityStatusBg(v.status)}`} />
                  <span className={`text-xs font-semibold ${velocityStatusColor(v.status)}`}>
                    {VELOCITY_LABELS[v.status]}
                  </span>
                </span>
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
                {fmtDays(v.daysPerStage)}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
                {fmtDays(v.etaDays)}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums font-semibold">
                {v.etaGap !== null ? `${v.etaGap > 0 ? "+" : ""}${fmtDays(v.etaGap)}` : "-"}
              </td>
              <td className="py-1.5 pr-3 text-xs text-muted-foreground">
                {trendArrow(v.trend)} {TREND_LABELS[v.trend]}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
                {v.daysSinceLastMovement !== null ? `${v.daysSinceLastMovement}d` : "-"}
              </td>
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
