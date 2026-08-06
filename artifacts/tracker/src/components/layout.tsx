import React, { useState, useMemo, useRef, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { BarChart3, Briefcase, Activity, Users, Database, FileText, Filter, X, Timer, Gauge, Factory, PackageCheck, CalendarIcon, Boxes, ChevronsUpDown } from "lucide-react";
import { useTracker, dateRangeWindow, useActiveJobSet, useJobTemplates, useContractorAliasMap, MULTI_JOBS_FILTER_VALUE, MULTI_TEMPLATES_FILTER_VALUE, isTemplateFilter, extractTemplateId, templateFilterValue, isNamedJobSetFilter, type JobTemplate, type MfcViewMode } from "@/lib/store";
import { useSettings } from "@/lib/settings";
import { useGetImportRecords, useGetAuthStatus, useListContractorCategories, getGetImportRecordsQueryKey, getGetAuthStatusQueryKey } from "@workspace/api-client-react";
import { LoginForm, ChangePasswordForm, LogoutButton } from "@/components/login-gate";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Segmented } from "@/components/ui/segmented";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { formatDate } from "@/lib/utils";
import { sortActivities, ACTIVITY_BUNDLES, OUT_VENDOR_TYPES, resolveContractorKey, normalizeContractorName } from "@workspace/domain";
import {
  buildContractorGroups,
  encodeContractorCategory,
  decodeContractorCategory,
} from "@/lib/contractorFilter";

// Job picker with checkbox multi-select. Renders "All Jobs" at the top,
// then named Job Templates (each with a checkbox for multi-select),
// then individual project/batch codes with checkboxes.
function MultiJobPicker({
  jobs,
  filterJob,
  selectedJobs,
  selectedTemplateIds,
  onAllJobs,
  onSelectedJobsChange,
  onSelectedTemplatesChange,
  templates,
}: {
  jobs: string[];
  filterJob: string | null;
  selectedJobs: string[];
  selectedTemplateIds: number[];
  onAllJobs: () => void;
  onSelectedJobsChange: (jobs: string[]) => void;
  onSelectedTemplatesChange: (ids: number[]) => void;
  templates: JobTemplate[];
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const selectedJobSet = useMemo(() => new Set(selectedJobs), [selectedJobs]);
  const selectedTplSet = useMemo(() => new Set(selectedTemplateIds), [selectedTemplateIds]);

  const filtered = useMemo(
    () => (search ? jobs.filter((j) => j.toLowerCase().includes(search.toLowerCase())) : jobs),
    [jobs, search],
  );

  const isMultiTemplates = filterJob === MULTI_TEMPLATES_FILTER_VALUE;

  // Toggle a template checkbox — multiple templates can be active simultaneously.
  const toggleTemplate = (id: number) => {
    const next = new Set(selectedTplSet);
    if (next.has(id)) next.delete(id); else next.add(id);
    onSelectedTemplatesChange(Array.from(next));
  };

  // Toggle an individual project/batch combo checkbox. Always accumulates from
  // the current selectedJobs set (selectedJobs is independent of filterJob now).
  const toggleJob = (job: string) => {
    const base = new Set(selectedJobSet);
    if (base.has(job)) base.delete(job); else base.add(job);
    onSelectedJobsChange(Array.from(base).sort());
    setSearch("");
  };

  // Label shown on the trigger button.
  const label = (() => {
    if (isMultiTemplates) {
      if (selectedTemplateIds.length === 1) {
        return templates.find((t) => t.id === selectedTemplateIds[0])?.name ?? "1 Template";
      }
      return `${selectedTemplateIds.length} Templates`;
    }
    // Legacy single-template path (backward compat).
    if (filterJob && isTemplateFilter(filterJob)) {
      return templates.find((t) => t.id === extractTemplateId(filterJob))?.name ?? "Template";
    }
    if (selectedJobs.length === 1) return selectedJobs[0];
    if (selectedJobs.length > 1) return `${selectedJobs.length} Batches`;
    return "All Combos";
  })();

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
      <PopoverContent className="w-[260px] p-2" align="start">
        <div className="space-y-2">
          {/* Clear all combos */}
          <div className="space-y-0.5">
            <button
              onClick={() => { onSelectedJobsChange([]); setOpen(false); }}
              className={`w-full text-left px-2 py-1.5 rounded text-sm hover:bg-accent ${selectedJobs.length === 0 && !isMultiTemplates ? "bg-accent font-medium" : ""}`}
            >
              All Combos
            </button>
          </div>

          {/* Named templates — checkbox multi-select */}
          {templates.length > 0 && (
            <div className="border-t pt-2 space-y-0.5">
              {templates.map((t) => (
                <div
                  key={t.id}
                  className={`flex items-center gap-1.5 px-1 rounded text-sm hover:bg-accent ${isMultiTemplates && selectedTplSet.has(t.id) ? "bg-accent/60" : ""}`}
                >
                  <Checkbox
                    checked={isMultiTemplates && selectedTplSet.has(t.id)}
                    onCheckedChange={() => toggleTemplate(t.id)}
                    onClick={(e: React.MouseEvent) => e.stopPropagation()}
                    className="shrink-0"
                  />
                  <button
                    className="flex-1 text-left py-1.5 truncate cursor-pointer"
                    onClick={() => toggleTemplate(t.id)}
                  >
                    {t.name}
                    <span className="ml-1.5 text-xs text-muted-foreground">({t.members.length})</span>
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Individual Job / Batch combos — checkbox multi-select */}
          <div className="border-t pt-2 space-y-1.5">
            <div className="flex items-center justify-between text-xs px-0.5">
              <span className="text-muted-foreground font-medium">Job / Batch</span>
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
                <p className="text-xs text-muted-foreground text-center py-2">No batches found</p>
              )}
              {filtered.map((job) => (
                <div
                  key={job}
                  className={`flex items-center gap-1 px-1 rounded text-sm hover:bg-accent`}
                >
                  <Checkbox
                    checked={selectedJobSet.has(job)}
                    onCheckedChange={() => toggleJob(job)}
                    onClick={(e: React.MouseEvent) => e.stopPropagation()}
                    className="shrink-0"
                  />
                  <button
                    className="flex-1 text-left py-1.5 truncate cursor-pointer"
                    onClick={() => toggleJob(job)}
                  >
                    {job}
                  </button>
                </div>
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
  { href: "/inventory", icon: Boxes, label: "Bucket List", short: "Bucket List" },
  { href: "/reports", icon: FileText, label: "Reports", short: "Reports" },
  { href: "/turnaround", icon: Timer, label: "Turn Around Time", short: "Turnaround" },
  { href: "/stuck", icon: Gauge, label: "Speed of Execution", short: "Speed" },
  { href: "/data", icon: Database, label: "Data", short: "Data" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { selectedImportId } = useTracker();

  // Auth — all hooks must be called before any conditional return.
  const { data: authStatus, isLoading: authLoading } = useGetAuthStatus({
    query: { queryKey: getGetAuthStatusQueryKey(), staleTime: 30_000 },
  });

  const isAuthenticated = authStatus?.authenticated === true;
  const mustChangePassword = isAuthenticated && authStatus?.mustChangePassword === true;
  const isAdmin = authStatus?.role === "admin";
  const displayLabel = authStatus?.displayName || authStatus?.email || "";

  const showFilters =
    location !== "/data" &&
    location !== "/order-reconciliation" &&
    location !== "/contractor-setup" &&
    location !== "/warning-parameters" &&
    location !== "/thickness" &&
    location !== "/users" &&
    location !== "/bucket-list-dates" &&
    selectedImportId != null;

  // While the initial auth check is in-flight, show a blank screen so there
  // is no flash of un-gated content.
  if (authLoading) {
    return (
      <div className="min-h-[100dvh] bg-background" />
    );
  }

  // Not logged in → full-screen login form (no nav chrome).
  if (!isAuthenticated) return <LoginForm />;

  // Must change password → force the change before any page loads.
  if (mustChangePassword) return <ChangePasswordForm />;

  // Data page is admin-only. Regular users reach Bucket List Dates via its own route.
  const visibleNavItems = isAdmin ? navItems : navItems.filter((n) => n.href !== "/data");

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background text-foreground pb-16 md:pb-0">
      {/* Compact top bar (Mobile) — brand + back to VTPL home */}
      <div className="md:hidden sticky top-0 z-40 flex items-center justify-between bg-sidebar border-b border-sidebar-border px-4 py-2">
        <Link href="~/" className="flex items-baseline gap-2">
          <span className="font-bold text-base text-primary tracking-tight">VTPL</span>
          <span className="text-[11px] text-sidebar-foreground/60">Production Tracker</span>
        </Link>
        <LogoutButton />
      </div>

      {/* Top Nav (Desktop) */}
      <header className="hidden md:flex sticky top-0 z-40 min-h-11 bg-sidebar border-b border-sidebar-border items-center flex-wrap gap-x-3 gap-y-1 px-4 py-1">
        <Link href="~/" title="VTPL Master Tracker" className="shrink-0 flex items-baseline gap-2">
          <span className="font-bold text-lg text-primary tracking-tight">VTPL</span>
          <span className="text-xs text-sidebar-foreground/60 hidden lg:inline">Production Activity Tracker</span>
        </Link>
        <nav className="flex flex-1 items-center justify-center flex-nowrap gap-x-0.5">
          {visibleNavItems.map((item) =>
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
        {/* Signed-in user + logout */}
        <div className="shrink-0 flex items-center gap-2 ml-2">
          {displayLabel && (
            <span className="text-xs text-sidebar-foreground/70 hidden xl:block max-w-[180px] truncate" title={displayLabel}>
              {displayLabel}
            </span>
          )}
          <LogoutButton />
        </div>
      </header>

      {/* Active WIP cutoff indicator (visible on every page/breakpoint) */}
      <CutoffBanner />

      {/* Global Filter Bar */}
      {showFilters && <FilterBar />}

      {/* Main Content */}
      <main className="flex-1 w-full max-w-7xl mx-auto p-3 md:p-4 overflow-x-hidden">
        {children}
      </main>

      {/* Bottom Nav (Mobile) */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 h-16 bg-sidebar border-t border-sidebar-border z-50 flex items-stretch pb-safe">
        {visibleNavItems.map((item) => {
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

// Plant location display labels.
const PLANT_LOCATION_LABELS: Record<string, string> = {
  unit_1: "Unit 1",
  unit_2: "Unit 2",
};

// Multi-select picker for Plant Location (unit_1 / unit_2 etc.). Shows every
// distinct location found in the contractor-categories overlay as checkboxes.
function PlantLocationPicker({
  available,
  selected,
  onChange,
}: {
  available: string[];
  selected: string[];
  onChange: (locs: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const toggle = (loc: string) => {
    const next = new Set(selectedSet);
    if (next.has(loc)) next.delete(loc); else next.add(loc);
    onChange(Array.from(next));
  };

  const label =
    selected.length === 0
      ? "All Locations"
      : selected.length === 1
        ? (PLANT_LOCATION_LABELS[selected[0]] ?? selected[0])
        : `${selected.length} Locations`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={selected.length > 0 ? "secondary" : "outline"}
          size="sm"
          className="h-9 w-full justify-between font-normal text-sm"
        >
          <span className="truncate">{label}</span>
          <ChevronsUpDown className="h-4 w-4 opacity-50 shrink-0 ml-1" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[180px] p-2" align="start">
        <div className="space-y-0.5">
          <button
            onClick={() => { onChange([]); setOpen(false); }}
            className={`w-full text-left px-2 py-1.5 rounded text-sm hover:bg-accent ${selected.length === 0 ? "bg-accent font-medium" : ""}`}
          >
            All Locations
          </button>
          {available.map((loc) => (
            <div
              key={loc}
              className={`flex items-center gap-1.5 px-1 rounded text-sm hover:bg-accent ${selectedSet.has(loc) ? "bg-accent/50" : ""}`}
            >
              <Checkbox
                checked={selectedSet.has(loc)}
                onCheckedChange={() => toggle(loc)}
                onClick={(e: React.MouseEvent) => e.stopPropagation()}
                className="shrink-0"
              />
              <button className="flex-1 text-left py-1.5" onClick={() => toggle(loc)}>
                {PLANT_LOCATION_LABELS[loc] ?? loc}
              </button>
            </div>
          ))}
          {available.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-2">No locations set</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function FilterBar() {
  const [location] = useLocation();
  const { filters, setFilter, setSelectedJobs, setSelectedTemplates, setPlantLocations, clearFilters, selectedImportId, mfcViewMode, setMfcViewMode } = useTracker();

  // Rule: navigating from one page to another resets every filter to its
  // default (the Order Type mode is preserved — it is a mode, not a filter).
  // Stale filters carried across pages routinely produced confusing empty
  // views (e.g. a template selection emptying an unrelated page).
  const prevLocation = useRef(location);
  useEffect(() => {
    if (prevLocation.current !== location) {
      prevLocation.current = location;
      clearFilters();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);
  const { data: contractorCategoriesData = [] } = useListContractorCategories();
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

  // Three independent TLT filter dimensions:
  //   jobs   = plain job codes for the "Jobs" single-select picker
  //   combos = "job - batch" pairs for the "Job/Batch" multi-checkbox picker
  //   mfcBatches = distinct batch letters for the "MFC Batch" single-select
  const jobs = useMemo(
    () => Array.from(new Set(modeRecords.map(r => r.job).filter((j): j is string => Boolean(j)))).sort(),
    [modeRecords]
  );
  const combos = useMemo(
    () => {
      const set = new Set<string>();
      for (const r of modeRecords) {
        if (!r.job) continue;
        set.add(r.mfcBatch ? `${r.job} - ${r.mfcBatch}` : r.job);
      }
      return Array.from(set).sort();
    },
    [modeRecords]
  );
  const mfcBatches = useMemo(
    () => Array.from(new Set(modeRecords.map(r => r.mfcBatch).filter((b): b is string => Boolean(b)))).sort(),
    [modeRecords]
  );

  // Named-set sentinels (templates / legacy current-jobs) — must be declared
  // before matchesJobFilter which references activeJobSet.
  const activeJobSet = useActiveJobSet();
  const templates = useJobTemplates();

  // Helper: does a record match all active job-related filters?
  // Three independent filters ANDed together:
  //   filters.job        — plain job code (single select)
  //   filters.mfcBatch   — MFC batch letter (single select)
  //   filters.selectedJobs — "job - batch" combo multi-select
  const matchesJobFilter = (rJob: string | null | undefined, rMfcBatch?: string | null | undefined) => {
    // 1. Named set / template filter (uses activeJobSet).
    // activeJobSet may contain combo keys ("821 - Z") or plain codes; check both.
    if (isNamedJobSetFilter(filters.job)) {
      const comboKey = rMfcBatch ? `${rJob} - ${rMfcBatch}` : null;
      if (!activeJobSet.has(rJob ?? "") && !(comboKey && activeJobSet.has(comboKey))) return false;
    } else if (filters.job && filters.job !== MULTI_JOBS_FILTER_VALUE) {
      // 2. Plain job code filter.
      if (rJob !== filters.job) return false;
    }
    // 3. MFC batch filter (single select).
    if (filters.mfcBatch && (rMfcBatch || "Z") !== filters.mfcBatch) return false;
    // 4. Job/Batch combo multi-select.
    if (filters.selectedJobs.length > 0) {
      const comboKey = rMfcBatch ? `${rJob} - ${rMfcBatch}` : null;
      if (!filters.selectedJobs.includes(rJob ?? "") && !(comboKey && filters.selectedJobs.includes(comboKey))) return false;
    }
    return true;
  };

  // Rows narrowed by the active PRIMARY-dimension selection(s), so the
  // secondary option lists (Contractor / Activity / Mark) only offer values
  // that actually exist within the current drill-down.
  const scopedRecords = useMemo(
    () => modeRecords.filter(r => isNtlt
      ? (!filters.ntltSubtype || r.ntltSubtype === filters.ntltSubtype) &&
        (!filters.section || r.groupKey === filters.section)
      : matchesJobFilter(r.job, r.mfcBatch) &&
        (!filters.structure || r.structure === filters.structure)),
    [modeRecords, isNtlt, filters.ntltSubtype, filters.section, filters.job, filters.selectedJobs, filters.structure, activeJobSet]
  );
  // NTLT primary dimension = Section (the cleaned group_key), narrowed to the
  // active sub-category so only relevant sections are offered.
  const sections = useMemo(
    () => Array.from(new Set(modeRecords
      .filter(r => !filters.ntltSubtype || r.ntltSubtype === filters.ntltSubtype)
      .map(r => r.groupKey).filter((k): k is string => Boolean(k)))).sort(),
    [modeRecords, filters.ntltSubtype]
  );

  const structures = useMemo(
    () => Array.from(new Set(modeRecords
      .filter(r => matchesJobFilter(r.job, r.mfcBatch))
      .map(r => r.structure)
      .filter(Boolean)
    )).sort(),
    [modeRecords, filters.job, filters.selectedJobs, activeJobSet]
  );

  const marks = useMemo(
    () => Array.from(new Set(scopedRecords.map(r => r.markId).filter(Boolean))).sort(),
    [scopedRecords]
  );

  // Contractor options, deduped through the alias map: every raw string that
  // resolves to the same canonical key (approved dedup merge) collapses into a
  // single option. The representative shown/stored is the raw string whose
  // normalized form IS the canonical key (i.e. the canonical spelling) when it
  // appears in the data; otherwise the first variant seen. Matching is
  // alias-aware downstream (filterRecords / matchesContractorSelection), so
  // selecting the one option matches every variant.
  const contractorAliasMap = useContractorAliasMap();
  const contractors = useMemo(
    () => {
      const byKey = new Map<string, string>();
      for (const r of scopedRecords) {
        const c = r.contractor;
        if (!c) continue;
        const key = resolveContractorKey(c, contractorAliasMap);
        const existing = byKey.get(key);
        if (
          existing === undefined ||
          (normalizeContractorName(c) === key && normalizeContractorName(existing) !== key)
        ) {
          byKey.set(key, c);
        }
      }
      return Array.from(byKey.values()).sort();
    },
    [scopedRecords, contractorAliasMap]
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

  // Distinct plant locations observed in the contractor-categories overlay,
  // sorted for a stable display order.
  const availablePlantLocations = useMemo(
    () =>
      Array.from(
        new Set(
          contractorCategoriesData
            .map((c) => c.plantLocation)
            .filter(Boolean) as string[],
        ),
      ).sort(),
    [contractorCategoriesData],
  );

  const activeFilterCount = Object.entries(filters).filter(([k, v]) => {
    if (k === "category") return false; // Order Type is a mode, not a filter
    if (k === "selectedJobs") return (v as string[]).length > 0; // combo picker — independent
    if (k === "selectedTemplateIds") return false; // counted via job
    if (k === "plantLocations") return (v as string[]).length > 0;
    if (v === null || v === "") return false;
    if (Array.isArray(v)) return false;
    // MULTI_JOBS_FILTER_VALUE is a legacy sentinel that should no longer be set
    if (k === "job" && v === MULTI_JOBS_FILTER_VALUE) return false;
    if (k === "dateRange") return dateRangeWindow(v) !== null;
    return true;
  }).length;

  const filterBarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = filterBarRef.current;
    if (!el) return;
    const update = () => {
      // On md+ screens the nav bar itself is sticky at top-0 and is ~44px (min-h-11).
      // The filter bar sticks at top-11 (44px) on md and top-0 on mobile.
      // Table thead must pin below both, so we include the nav height here.
      const navH = window.matchMedia("(min-width: 768px)").matches ? 44 : 0;
      document.documentElement.style.setProperty("--filter-bar-h", `${navH + el.offsetHeight}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={filterBarRef} className="sticky top-0 md:top-11 z-30 bg-card border-b shadow-sm">
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
          {/* 1. Date Range — first after Order Type */}
          <DateRangeFilter />
          {/* 2. Plant Location (multi-select) */}
          <div className="w-[160px]">
            <PlantLocationPicker
              available={availablePlantLocations}
              selected={filters.plantLocations}
              onChange={setPlantLocations}
            />
          </div>
          {/* 3. Jobs / Section — plain job code (TLT) or group section (NTLT). */}
          <div className="w-full sm:w-[160px]">
            {isNtlt ? (
              <SearchableSelect
                value={filters.section}
                onChange={(v) => setFilter("section", v)}
                options={sections}
                allLabel="All Sections"
                searchPlaceholder="Search sections..."
              />
            ) : (
              <SearchableSelect
                value={filters.job === MULTI_JOBS_FILTER_VALUE ? null : filters.job}
                onChange={(v) => setFilter("job", v)}
                options={jobs}
                allLabel="All Jobs"
                searchPlaceholder="Search jobs..."
              />
            )}
          </div>
          {/* 4a. MFC Batch — single-select batch letter (TLT only). */}
          {!isNtlt && (
            <div className="w-[130px]">
              <SearchableSelect
                value={filters.mfcBatch}
                onChange={(v) => setFilter("mfcBatch", v)}
                options={mfcBatches}
                allLabel="All Batches"
                searchPlaceholder="Search batches..."
              />
            </div>
          )}
          {/* 4b. Job / Batch combo picker — multi-checkbox for exact job+batch combos (TLT only). */}
          {!isNtlt && (
            <div className="w-full sm:w-[180px]">
              <MultiJobPicker
                jobs={combos}
                filterJob={filters.job}
                selectedJobs={filters.selectedJobs}
                selectedTemplateIds={filters.selectedTemplateIds}
                onAllJobs={() => setFilter("job", null)}
                onSelectedJobsChange={setSelectedJobs}
                onSelectedTemplatesChange={setSelectedTemplates}
                templates={templates}
              />
            </div>
          )}
          {/* 5. Contractor */}
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
                  setFilter("contractor", null);
                  setFilter("contractorCategory", category);
                } else {
                  setFilter("contractorCategory", null);
                  setFilter("contractor", v);
                }
              }}
              groups={buildContractorGroups(contractors)}
              allLabel="All Contractors"
              searchPlaceholder="Search contractors or types..."
            />
          </div>
          {/* 6. Activity */}
          <div className="w-[180px]">
            <SearchableSelect
              value={filters.activity}
              onChange={(v) => setFilter("activity", v)}
              groups={activityGroups}
              allLabel="All Activities"
              searchPlaceholder="Search activities or bundles..."
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

        {/* Selected-job chip strip — shows which combo selections are active */}
        {filters.selectedJobs.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 md:px-6 pb-2">
            {filters.selectedJobs.map((job) => (
              <span
                key={job}
                className="inline-flex items-center gap-1 bg-primary/10 text-primary text-xs font-medium px-2 py-0.5 rounded-full border border-primary/20"
              >
                {job}
                <button
                  type="button"
                  onClick={() => setSelectedJobs(filters.selectedJobs.filter((j) => j !== job))}
                  className="leading-none opacity-70 hover:opacity-100"
                  aria-label={`Remove ${job}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

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
      {!isNtlt && isNamedJobSetFilter(filters.job) && activeJobSet.size === 0 && (
        <div className="bg-amber-500/10 border-t border-amber-500/25 text-amber-800 dark:text-amber-300 text-xs md:text-sm px-4 md:px-6 py-2 flex items-center gap-2">
          <Filter className="h-3.5 w-3.5 shrink-0" />
          <span>
            This job template contains no projects yet — it matches nothing. Add projects on the Job Templates page, or switch the Job filter back to All.
          </span>
        </div>
      )}

      {/* MFC View mode — hidden on the Data admin page, shown everywhere else */}
      <div className={`flex items-center gap-3 px-3 md:px-6 py-2 border-t bg-muted/20${location.includes("/data") ? " hidden" : ""}`}>
        <Segmented
          value={mfcViewMode}
          onChange={(v) => setMfcViewMode(v as MfcViewMode)}
          options={[
            { value: "project-with-mfc", label: "Project with MFC" },
            { value: "view-by-mfc",       label: "View by MFC" },
            { value: "project-then-mfc",  label: "Project Then MFC" },
          ]}
        />
      </div>
    </div>
  );
}
