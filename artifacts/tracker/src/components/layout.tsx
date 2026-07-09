import React, { useState, useMemo } from "react";
import { Link, useLocation } from "wouter";
import { BarChart3, Briefcase, Activity, Users, Database, FileText, Filter, X, Timer, Gauge, Factory, PackageCheck, CalendarIcon, Boxes, ChevronsUpDown } from "lucide-react";
import { useTracker, dateRangeWindow, useCurrentJobsSet, CURRENT_JOBS_FILTER_VALUE, MULTI_JOBS_FILTER_VALUE } from "@/lib/store";
import { useSettings } from "@/lib/settings";
import { useGetImportRecords, getGetImportRecordsQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Segmented } from "@/components/ui/segmented";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { formatDate } from "@/lib/utils";
import { sortActivities, ACTIVITY_BUNDLES, OUT_VENDOR_TYPES } from "@workspace/domain";
import {
  buildContractorGroups,
  encodeContractorCategory,
  decodeContractorCategory,
} from "@/lib/contractorFilter";

// Job picker with checkbox multi-select. Always rendered for the TLT job
// dimension — clicking "All Jobs" or "Current Jobs" sets those modes; clicking
// individual project codes toggles them in/out of a multi-selection. No
// separate "Select Multiple Jobs" activation step is required.
function MultiJobPicker({
  jobs,
  filterJob,
  selectedJobs,
  onAllJobs,
  onCurrentJobs,
  onSelectedJobsChange,
}: {
  jobs: string[];
  filterJob: string | null;
  selectedJobs: string[];
  onAllJobs: () => void;
  onCurrentJobs: () => void;
  onSelectedJobsChange: (jobs: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const selected = useMemo(() => new Set(selectedJobs), [selectedJobs]);
  const filtered = useMemo(
    () => (search ? jobs.filter((j) => j.toLowerCase().includes(search.toLowerCase())) : jobs),
    [jobs, search],
  );

  const toggle = (job: string) => {
    const next = new Set(selected);
    if (next.has(job)) next.delete(job); else next.add(job);
    onSelectedJobsChange(Array.from(next).sort());
  };

  const isCurrentJobs = filterJob === CURRENT_JOBS_FILTER_VALUE;
  const isMultiJobs = filterJob === MULTI_JOBS_FILTER_VALUE;

  const label = isCurrentJobs
    ? "Current Jobs"
    : isMultiJobs && selectedJobs.length === 1
      ? selectedJobs[0]
      : isMultiJobs && selectedJobs.length > 1
        ? `${selectedJobs.length} Jobs`
        : "All Jobs";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-9 w-full justify-between font-normal text-sm"
        >
          <span className="truncate">{label}</span>
          <ChevronsUpDown className="h-4 w-4 opacity-50 shrink-0 ml-1" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[240px] p-2" align="start">
        <div className="space-y-2">
          {/* Special-mode rows */}
          <div className="space-y-0.5">
            <button
              onClick={() => { onAllJobs(); setOpen(false); }}
              className={`w-full text-left px-2 py-1.5 rounded text-sm hover:bg-accent ${!filterJob ? "bg-accent font-medium" : ""}`}
            >
              All Jobs
            </button>
            <button
              onClick={() => { onCurrentJobs(); setOpen(false); }}
              className={`w-full text-left px-2 py-1.5 rounded text-sm hover:bg-accent ${isCurrentJobs ? "bg-accent font-medium" : ""}`}
            >
              Current Jobs
            </button>
          </div>
          <div className="border-t pt-2 space-y-1.5">
            <div className="flex items-center justify-between text-xs px-0.5">
              <span className="text-muted-foreground font-medium">Projects</span>
              <div className="flex gap-2">
                <button className="text-primary hover:underline" onClick={() => onSelectedJobsChange([...jobs])}>All</button>
                <button className="text-muted-foreground hover:underline" onClick={() => onSelectedJobsChange([])}>None</button>
              </div>
            </div>
            <input
              type="text"
              placeholder="Search..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded border px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ring bg-background"
            />
            <div className="max-h-52 overflow-y-auto space-y-0.5 pr-0.5">
              {filtered.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-2">No jobs found</p>
              )}
              {filtered.map((job) => (
                <label
                  key={job}
                  className="flex items-center gap-2 px-1.5 py-1 rounded cursor-pointer hover:bg-accent text-sm select-none"
                >
                  <Checkbox
                    checked={isMultiJobs ? selected.has(job) : false}
                    onCheckedChange={() => toggle(job)}
                  />
                  <span className="truncate">{job}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Date Range filter: presets encoded as short codes, a custom range as
// "custom:YYYY-MM-DD:YYYY-MM-DD" (either side may be blank while the user is
// still picking). Matches the codes understood by `dateRangeWindow` in
// lib/store.tsx — this component is purely a UI layer over that existing
// filter logic.
const RANGE_PRESETS: { value: string; label: string }[] = [
  { value: "1d", label: "Last 1 day" },
  { value: "7d", label: "Last 7 days" },
  { value: "15d", label: "Last 15 days" },
  { value: "3m", label: "Last 3 months" },
  { value: "6m", label: "Last 6 months" },
  { value: "9m", label: "Last 9 months" },
  { value: "1y", label: "Last 1 year" },
];

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The last `count` individual calendar months, most recent first, relative to
// today (excludes the current in-progress month). Encoded as "month:YYYY-MM".
function buildMonthPresets(count: number): { value: string; label: string }[] {
  const now = new Date();
  const out: { value: string; label: string }[] = [];
  for (let i = 1; i <= count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    out.push({
      value: `month:${y}-${String(m).padStart(2, "0")}`,
      label: `${MONTH_NAMES[m - 1]} ${y}`,
    });
  }
  return out;
}

// The last `count` fully-completed calendar quarters, most recent first,
// relative to today (excludes the current in-progress quarter). Each label
// carries its year so there's no ambiguity across year boundaries. Encoded
// as "quarter:YYYY-Q".
function buildQuarterPresets(count: number): { value: string; label: string }[] {
  const now = new Date();
  let y = now.getFullYear();
  let q = Math.floor(now.getMonth() / 3) + 1 - 1; // previous (completed) quarter
  const out: { value: string; label: string }[] = [];
  for (let i = 0; i < count; i++) {
    if (q < 1) {
      q = 4;
      y -= 1;
    }
    const startMonth = (q - 1) * 3;
    out.push({
      value: `quarter:${y}-${q}`,
      label: `Q${q} ${y} (${MONTH_NAMES[startMonth]}–${MONTH_NAMES[startMonth + 2]})`,
    });
    q -= 1;
  }
  return out;
}

function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dateRangeLabel(
  code: string | null,
  monthPresets: { value: string; label: string }[],
  quarterPresets: { value: string; label: string }[],
): string {
  if (!code) return "All Dates";
  if (code.startsWith("custom:")) {
    const [, s, e] = code.split(":");
    if (!s || !e) return "Custom range…";
    return `${formatDate(s)} – ${formatDate(e)}`;
  }
  const all = [...RANGE_PRESETS, ...monthPresets, ...quarterPresets];
  return all.find((p) => p.value === code)?.label ?? "All Dates";
}

function DateRangeFilter() {
  const { filters, setFilter } = useTracker();
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<{ from?: Date; to?: Date }>({});

  // Computed once relative to "today" — at least 6 individual preceding
  // months and 4 preceding full quarters, both excluding the current
  // in-progress period.
  const monthPresets = useMemo(() => buildMonthPresets(6), []);
  const quarterPresets = useMemo(() => buildQuarterPresets(4), []);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) return;
    if (filters.dateRange?.startsWith("custom:")) {
      const [, s, e] = filters.dateRange.split(":");
      setRange({ from: s ? new Date(s) : undefined, to: e ? new Date(e) : undefined });
    } else {
      setRange({});
    }
  };

  const pickPreset = (value: string | null) => {
    setFilter("dateRange", value);
    setOpen(false);
  };

  const pickCustom = (next: { from?: Date; to?: Date } | undefined) => {
    setRange(next ?? {});
    if (next?.from && next?.to) {
      setFilter("dateRange", `custom:${dayKey(next.from)}:${dayKey(next.to)}`);
      setOpen(false);
    }
  };

  const active = filters.dateRange !== null && dateRangeWindow(filters.dateRange) !== null;

  const sectionHeading = (label: string) => (
    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground px-2 pt-2.5 pb-1 first:pt-1">
      {label}
    </p>
  );

  return (
    <div className="w-full sm:w-[190px]">
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button
            variant={active ? "secondary" : "outline"}
            size="sm"
            className="h-9 w-full justify-start gap-2 font-normal"
          >
            <CalendarIcon className="h-4 w-4 shrink-0" />
            <span className="truncate">{dateRangeLabel(filters.dateRange, monthPresets, quarterPresets)}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <div className="flex flex-col sm:flex-row">
            <div className="flex flex-col gap-0.5 border-b sm:border-b-0 sm:border-r min-w-[190px] max-h-[380px] overflow-y-auto px-1 pb-2">
              <div className="pt-1">
                <Button variant="ghost" size="sm" className="justify-start w-full" onClick={() => pickPreset(null)}>
                  All Dates
                </Button>
              </div>

              {sectionHeading("Quick ranges")}
              {RANGE_PRESETS.map((p) => (
                <Button
                  key={p.value}
                  variant={filters.dateRange === p.value ? "secondary" : "ghost"}
                  size="sm"
                  className="justify-start"
                  onClick={() => pickPreset(p.value)}
                >
                  {p.label}
                </Button>
              ))}

              {sectionHeading("By month")}
              {monthPresets.map((p) => (
                <Button
                  key={p.value}
                  variant={filters.dateRange === p.value ? "secondary" : "ghost"}
                  size="sm"
                  className="justify-start"
                  onClick={() => pickPreset(p.value)}
                >
                  {p.label}
                </Button>
              ))}

              {sectionHeading("By quarter")}
              {quarterPresets.map((p) => (
                <Button
                  key={p.value}
                  variant={filters.dateRange === p.value ? "secondary" : "ghost"}
                  size="sm"
                  className="justify-start"
                  onClick={() => pickPreset(p.value)}
                >
                  {p.label}
                </Button>
              ))}
            </div>
            <div className="p-2">
              <p className="text-xs text-muted-foreground px-1 pb-1">Custom range (based on Assign Date)</p>
              <Calendar
                mode="range"
                numberOfMonths={1}
                selected={range.from ? { from: range.from, to: range.to } : undefined}
                onSelect={pickCustom}
                defaultMonth={range.from}
              />
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

type NavItem = {
  href: string;
  icon: typeof BarChart3;
  label: string;
  short: string;
  disabled?: boolean;
};

const navItems: NavItem[] = [
  { href: "/", icon: BarChart3, label: "Overview", short: "Overview" },
  { href: "/jobs", icon: Briefcase, label: "Project Wise", short: "Projects" },
  { href: "/activity", icon: Activity, label: "Activity Wise", short: "Activity" },
  { href: "/contractor", icon: Users, label: "Contractor Wise", short: "Contractors" },
  { href: "/plant", icon: Factory, label: "Plant Operation Wise", short: "Plant Ops" },
  { href: "/order-status", icon: PackageCheck, label: "Order Status", short: "Orders" },
  { href: "/inventory", icon: Boxes, label: "Bucket List", short: "Bucket List" },
  { href: "/reports", icon: FileText, label: "Reports", short: "Reports" },
  { href: "/turnaround", icon: Timer, label: "Turn Around Time", short: "Turnaround" },
  { href: "/stuck", icon: Gauge, label: "Stuck Projects", short: "Stuck" },
  { href: "/data", icon: Database, label: "Data", short: "Data" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { selectedImportId } = useTracker();
  const showFilters =
    location !== "/data" &&
    location !== "/order-reconciliation" &&
    location !== "/contractor-setup" &&
    location !== "/warning-parameters" &&
    location !== "/thickness" &&
    location !== "/jobs" &&
    selectedImportId != null;

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background text-foreground pb-16 md:pb-0">
      {/* Compact top bar (Mobile) — brand + back to VTPL home */}
      <div className="md:hidden sticky top-0 z-40 flex items-center justify-between bg-sidebar border-b border-sidebar-border px-4 py-2">
        <Link href="~/" className="flex items-baseline gap-2">
          <span className="font-bold text-base text-primary tracking-tight">VTPL</span>
          <span className="text-[11px] text-sidebar-foreground/60">Production Tracker</span>
        </Link>
      </div>

      {/* Top Nav (Desktop) */}
      <header className="hidden md:flex sticky top-0 z-40 min-h-14 bg-sidebar border-b border-sidebar-border items-center flex-wrap gap-x-3 gap-y-1 px-4 py-1.5">
        <Link href="~/" title="VTPL Master Tracker" className="shrink-0 flex items-baseline gap-2">
          <span className="font-bold text-lg text-primary tracking-tight">VTPL</span>
          <span className="text-xs text-sidebar-foreground/60 hidden lg:inline">Production Activity Tracker</span>
        </Link>
        <nav className="flex flex-1 items-center justify-center flex-nowrap gap-x-0.5">
          {navItems.map((item) =>
            item.disabled ? (
              <div
                key={item.href}
                title={`${item.label} (disabled)`}
                aria-disabled="true"
                className="px-2 py-1 rounded-md text-xs font-medium text-center leading-tight text-sidebar-foreground/40 cursor-not-allowed select-none"
              >
                {item.label}
              </div>
            ) : (
              <Link key={item.href} href={item.href}>
                <div
                  title={item.label}
                  className={`px-2 py-1 rounded-md text-xs font-medium text-center leading-tight transition-colors cursor-pointer ${
                    location === item.href
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-accent/50"
                  }`}
                >
                  {item.label}
                </div>
              </Link>
            ),
          )}
        </nav>
      </header>

      {/* Active WIP cutoff indicator (visible on every page/breakpoint) */}
      <CutoffBanner />

      {/* Global Filter Bar */}
      {showFilters && <FilterBar />}

      {/* Main Content */}
      <main className="flex-1 w-full max-w-7xl mx-auto p-4 md:p-6 overflow-x-hidden">
        {children}
      </main>

      {/* Bottom Nav (Mobile) */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 h-16 bg-sidebar border-t border-sidebar-border z-50 flex items-stretch pb-safe">
        {navItems.map((item) => {
          const isActive = location === item.href;
          const Icon = item.icon;
          if (item.disabled) {
            return (
              <div
                key={item.href}
                aria-disabled="true"
                className="flex-1 min-w-0 flex flex-col items-center justify-center h-full px-0.5 text-sidebar-foreground/30 cursor-not-allowed select-none"
              >
                <Icon className="h-5 w-5 mb-1 shrink-0" strokeWidth={2} />
                <span className="text-[10px] font-medium leading-tight truncate max-w-full">{item.short}</span>
              </div>
            );
          }
          return (
            <Link key={item.href} href={item.href} className="flex-1 min-w-0">
              <div className={`flex flex-col items-center justify-center w-full h-full px-0.5 cursor-pointer transition-colors ${
                isActive ? "text-primary" : "text-sidebar-foreground/70 hover:text-sidebar-foreground"
              }`}>
                <Icon className="h-5 w-5 mb-1 shrink-0" strokeWidth={isActive ? 2.5 : 2} />
                <span className="text-[10px] font-medium leading-tight truncate max-w-full">{item.label}</span>
              </div>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

function CutoffBanner() {
  const { settings } = useSettings();
  const cutoff = settings.validFromDate;
  if (!cutoff) return null;
  return (
    <div className="bg-amber-500/10 border-b border-amber-500/25 text-amber-800 dark:text-amber-300 text-xs md:text-sm px-4 md:px-6 py-2 flex items-center gap-2">
      <Filter className="h-3.5 w-3.5 shrink-0" />
      <span>
        Showing WIP data from <span className="font-semibold tabular-nums">{cutoff}</span> onward. Earlier imports are hidden across every view. Change this on the Data tab.
      </span>
    </div>
  );
}

function FilterBar() {
  const { filters, setFilter, setSelectedJobs, clearFilters, selectedImportId } = useTracker();
  const [isOpen, setIsOpen] = useState(false);
  const { data: records = [] } = useGetImportRecords(selectedImportId as number, {
    query: { enabled: !!selectedImportId, queryKey: getGetImportRecordsQueryKey(selectedImportId as number) }
  });

  const isNtlt = filters.category === "NTLT";
  // "All" Order Type includes both TLT and NTLT — no category gate.
  const isAll = filters.category === "ALL";

  // Rows in the current Order Type mode drive every option list, so secondary
  // filters (Contractor/Activity) and the Mark picker only offer mode-relevant
  // values. Inactive marks (FOUNDATION BOLT) are excluded everywhere.
  const modeRecords = useMemo(
    () => records.filter(r => (isAll || (r.category || "TLT") === filters.category) && r.active !== false),
    [records, filters.category, isAll]
  );

  // TLT primary dimension = Project (job).
  const jobs = useMemo(
    () => Array.from(new Set(modeRecords.map(r => r.job).filter(Boolean))).sort(),
    [modeRecords]
  );

  // "Current Jobs" / "Select Multiple Jobs" sentinels — must be declared
  // before matchesJobFilter which references currentJobsSet.
  const { set: currentJobsSet } = useCurrentJobsSet();

  // Helper: does a record match the current job filter (handles sentinels).
  const matchesJobFilter = (rJob: string | null | undefined) => {
    if (!filters.job) return true;
    if (filters.job === CURRENT_JOBS_FILTER_VALUE) return currentJobsSet.has(rJob ?? "");
    if (filters.job === MULTI_JOBS_FILTER_VALUE) {
      return filters.selectedJobs.length === 0 || filters.selectedJobs.includes(rJob ?? "");
    }
    return rJob === filters.job;
  };

  // Rows narrowed by the active PRIMARY-dimension selection(s), so the
  // secondary option lists (Contractor / Activity / Mark) only offer values
  // that actually exist within the current drill-down.
  const scopedRecords = useMemo(
    () => modeRecords.filter(r => isNtlt
      ? (!filters.ntltSubtype || r.ntltSubtype === filters.ntltSubtype) &&
        (!filters.section || r.groupKey === filters.section)
      : matchesJobFilter(r.job) &&
        (!filters.mfcBatch || (r.mfcBatch || "Z") === filters.mfcBatch) &&
        (!filters.structure || r.structure === filters.structure)),
    [modeRecords, isNtlt, filters.ntltSubtype, filters.section, filters.job, filters.selectedJobs, filters.mfcBatch, filters.structure, currentJobsSet]
  );
  // isMultiJobs = job filter is in checkbox multi-select mode.
  const isMultiJobs = filters.job === MULTI_JOBS_FILTER_VALUE;

  // NTLT primary dimension = Section (the cleaned group_key), narrowed to the
  // active sub-category so only relevant sections are offered.
  const sections = useMemo(
    () => Array.from(new Set(modeRecords
      .filter(r => !filters.ntltSubtype || r.ntltSubtype === filters.ntltSubtype)
      .map(r => r.groupKey).filter((k): k is string => Boolean(k)))).sort(),
    [modeRecords, filters.ntltSubtype]
  );

  // TLT sub-level = MFC batch (WO Batch No.), between Project and Structure.
  // Narrowed to the active project; sorted A..Z so the blank-origin "Z" bucket
  // always lands last.
  const mfcBatches = useMemo(
    () => Array.from(new Set(modeRecords
      .filter(r => matchesJobFilter(r.job))
      .map(r => r.mfcBatch || "Z")
    )).sort(),
    [modeRecords, filters.job, filters.selectedJobs, currentJobsSet]
  );

  const structures = useMemo(
    () => Array.from(new Set(modeRecords
      .filter(r => matchesJobFilter(r.job) && (!filters.mfcBatch || (r.mfcBatch || "Z") === filters.mfcBatch))
      .map(r => r.structure)
      .filter(Boolean)
    )).sort(),
    [modeRecords, filters.job, filters.selectedJobs, filters.mfcBatch, currentJobsSet]
  );

  const marks = useMemo(
    () => Array.from(new Set(scopedRecords.map(r => r.markId).filter(Boolean))).sort(),
    [scopedRecords]
  );

  const contractors = useMemo(
    () => Array.from(new Set(scopedRecords.map(r => r.contractor).filter((c): c is string => Boolean(c)))).sort(),
    [scopedRecords]
  );

  const activities = useMemo(
    () => sortActivities(Array.from(new Set(scopedRecords.map(r => r.activity).filter((a): a is string => Boolean(a))))),
    [scopedRecords]
  );

  // Activity dropdown = a "Bundles" group (shortcut filters) above the plain
  // "Activities" group. Bundle selections are encoded as "bundle:<id>" in the
  // single activity slot. NTLT mode offers only ALL-scope bundles (Galvanizing,
  // Yard); TLT and All modes offer every bundle.
  const activityGroups = useMemo(() => {
    const bundles = ACTIVITY_BUNDLES
      .filter(b => !b.hidden && (isNtlt ? b.scope === "ALL" : true))
      .map(b => ({ value: `bundle:${b.id}`, label: b.label }));
    const groups: { heading?: string; options: { value: string; label: string }[] }[] = [];
    if (bundles.length) groups.push({ heading: "Bundles", options: bundles });
    groups.push({ heading: "Activities", options: activities.map(a => ({ value: a, label: a })) });
    return groups;
  }, [activities, isNtlt]);

  // Hole operation (derived, all order types) counts scoped to the current
  // drill-down, so the dropdown shows how many marks fall in each bucket and the
  // NOT_SET gap is always visible.
  const holeOpCounts = useMemo(() => {
    const c: { PUNCHING: number; DRILLING: number; NOT_SET: number } = {
      PUNCHING: 0,
      DRILLING: 0,
      NOT_SET: 0,
    };
    for (const r of scopedRecords) {
      const op = (r.holeOperation as keyof typeof c) || "NOT_SET";
      if (op in c) c[op] += 1;
      else c.NOT_SET += 1;
    }
    return c;
  }, [scopedRecords]);

  const holeOperationOptions = useMemo(
    () => [
      { value: "PUNCHING", label: `Punching (${holeOpCounts.PUNCHING})` },
      { value: "DRILLING", label: `Drilling (${holeOpCounts.DRILLING})` },
      { value: "NOT_SET", label: `Not set (${holeOpCounts.NOT_SET})` },
    ],
    [holeOpCounts],
  );

  const activeFilterCount = Object.entries(filters).filter(([k, v]) => {
    if (k === "category") return false; // Order Type is a mode, not a filter
    if (v === null || v === "") return false;
    if (k === "dateRange") return dateRangeWindow(v) !== null;
    return true;
  }).length;

  return (
    <div className="sticky top-0 md:top-14 z-30 bg-card border-b shadow-sm">
      <Collapsible open={isOpen} onOpenChange={setIsOpen} className="w-full">
        <div className="flex items-center gap-2 p-3 md:px-6 flex-wrap">
          <span className="text-xs font-semibold text-muted-foreground uppercase mr-1">
            Order Type
          </span>
          <Segmented
            value={filters.category}
            onChange={(v) => setFilter("category", v)}
            options={[
              { value: "ALL", label: "All" },
              { value: "TLT", label: "TLT" },
              { value: "NTLT", label: "NTLT" },
            ]}
          />
          {isNtlt && (
            <Segmented
              value={filters.ntltSubtype}
              onChange={(v) => setFilter("ntltSubtype", v)}
              options={[
                { value: null, label: "All NTLT" },
                { value: "RSJ", label: "RSJ" },
                { value: "EARTHING", label: "Earthing" },
                { value: "GENERAL", label: "General" },
              ]}
            />
          )}
          {/* In ALL mode isNtlt is false, so this defaults to the Job picker —
             the primary TLT dimension — which is what users expect when "All"
             order types are shown. NTLT mode swaps it for the Section picker. */}
          <div className="w-full sm:w-[220px]">
            {isNtlt ? (
              <SearchableSelect
                value={filters.section}
                onChange={(v) => setFilter("section", v)}
                options={sections}
                allLabel="All Sections"
                searchPlaceholder="Search sections..."
              />
            ) : (
              <MultiJobPicker
                jobs={jobs as string[]}
                filterJob={filters.job}
                selectedJobs={filters.selectedJobs}
                onAllJobs={() => setFilter("job", null)}
                onCurrentJobs={() => setFilter("job", CURRENT_JOBS_FILTER_VALUE)}
                onSelectedJobsChange={setSelectedJobs}
              />
            )}
          </div>
          {/* MFC batch (TLT sub-level, between Project and Structure). Hidden in
             NTLT mode where Section is the primary dimension. */}
          {!isNtlt && (
            <div className="w-[150px]">
              <SearchableSelect
                value={filters.mfcBatch}
                onChange={(v) => setFilter("mfcBatch", v)}
                options={mfcBatches}
                allLabel="All MFC"
                searchPlaceholder="Search MFC..."
              />
            </div>
          )}
          <div className="w-[180px]">
            <SearchableSelect
              value={filters.activity}
              onChange={(v) => setFilter("activity", v)}
              groups={activityGroups}
              allLabel="All Activities"
              searchPlaceholder="Search activities or bundles..."
            />
          </div>
          <DateRangeFilter />
          <div className="flex-1 min-w-[180px] max-w-[340px]">
            <SearchableSelect
              value={
                filters.contractor ??
                (filters.contractorCategory
                  ? encodeContractorCategory(filters.contractorCategory)
                  : null)
              }
              onChange={(v) => {
                const category = decodeContractorCategory(v);
                if (category !== null) {
                  // A classification was picked: drive the category filter and
                  // clear any specific-contractor selection.
                  setFilter("contractor", null);
                  setFilter("contractorCategory", category);
                } else {
                  // A specific contractor (or "All") was picked: clear the
                  // classification so the two never stack.
                  setFilter("contractorCategory", null);
                  setFilter("contractor", v);
                }
              }}
              groups={buildContractorGroups(contractors)}
              allLabel="All Contractors"
              searchPlaceholder="Search contractors or types..."
            />
          </div>
          <div className="flex items-center gap-2 ml-auto">
            {activeFilterCount > 0 && (
              <Button variant="ghost" size="sm" onClick={clearFilters} className="h-9 px-2 text-muted-foreground">
                Clear
              </Button>
            )}
            <CollapsibleTrigger asChild>
              <Button variant={activeFilterCount > 0 ? "secondary" : "outline"} size="sm" className="h-9 gap-2">
                <Filter className="h-4 w-4" />
                <span className="hidden sm:inline">Filters</span>
                {activeFilterCount > 0 && (
                  <span className="bg-primary text-primary-foreground text-xs px-1.5 py-0.5 rounded-full min-w-[20px] text-center">
                    {activeFilterCount}
                  </span>
                )}
              </Button>
            </CollapsibleTrigger>
          </div>
        </div>
        
        <CollapsibleContent>
          <div className="p-3 md:px-6 pt-0 border-t bg-muted/30 grid grid-cols-2 gap-3">
            {!isNtlt && (
              <div className="space-y-1">
                <label className="text-xs font-semibold text-muted-foreground uppercase">Structure</label>
                <SearchableSelect
                  value={filters.structure}
                  onChange={(v) => setFilter("structure", v)}
                  options={structures}
                  allLabel="All Structures"
                  searchPlaceholder="Search structures..."
                  disabled={structures.length === 0}
                />
              </div>
            )}
            <div className="space-y-1">
              <label className="text-xs font-semibold text-muted-foreground uppercase">Mark</label>
              <SearchableSelect
                value={filters.mark}
                onChange={(v) => setFilter("mark", v)}
                options={marks}
                allLabel="All Marks"
                searchPlaceholder="Search marks..."
                disabled={marks.length === 0}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-muted-foreground uppercase">Hole Operation</label>
              <SearchableSelect
                value={filters.holeOperation}
                onChange={(v) => setFilter("holeOperation", v)}
                groups={[{ options: holeOperationOptions }]}
                allLabel="All Operations"
                searchPlaceholder="Search operations..."
              />
              <p className="text-[11px] text-muted-foreground">
                {holeOpCounts.NOT_SET} mark{holeOpCounts.NOT_SET === 1 ? "" : "s"} not set
              </p>
            </div>
            {filters.contractorCategory === "OUT_VENDOR" && (
              <div className="space-y-1">
                <label className="text-xs font-semibold text-muted-foreground uppercase">Out-vendor Tag</label>
                <SearchableSelect
                  value={filters.outVendorType}
                  onChange={(v) => setFilter("outVendorType", v)}
                  groups={[{ options: OUT_VENDOR_TYPES.map((t) => ({ value: t.value, label: t.label })) }]}
                  allLabel="All Tags"
                  searchPlaceholder="Search tags..."
                />
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
      {!isNtlt && filters.job === CURRENT_JOBS_FILTER_VALUE && currentJobsSet.size === 0 && (
        <div className="bg-amber-500/10 border-t border-amber-500/25 text-amber-800 dark:text-amber-300 text-xs md:text-sm px-4 md:px-6 py-2 flex items-center gap-2">
          <Filter className="h-3.5 w-3.5 shrink-0" />
          <span>
            No Current Jobs list has been uploaded yet (or it was cleared). Upload one on the Data tab, or switch the Job filter back to All.
          </span>
        </div>
      )}
    </div>
  );
}
