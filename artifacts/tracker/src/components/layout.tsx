import React, { useState, useMemo } from "react";
import { Link, useLocation } from "wouter";
import { BarChart3, Briefcase, Activity, Clock, Users, UserCog, Database, FileText, SlidersHorizontal, Filter, X, Timer, Gauge, CheckCircle2, Layers, Factory } from "lucide-react";
import { useTracker, dateRangeWindow } from "@/lib/store";
import { useGetImportRecords, getGetImportRecordsQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { DateRangeSelect } from "@/components/date-range-select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Segmented } from "@/components/ui/segmented";
import { sortActivities, ACTIVITY_BUNDLES, CONTRACTOR_CATEGORIES, OUT_VENDOR_TYPES } from "@workspace/domain";

const navItems = [
  { href: "/", icon: BarChart3, label: "Overview" },
  { href: "/jobs", icon: Briefcase, label: "Project Wise" },
  { href: "/activity", icon: Activity, label: "Activity Wise" },
  { href: "/contractor", icon: Users, label: "Contractor Wise" },
  { href: "/plant", icon: Factory, label: "Plant Operation Wise" },
  { href: "/contractor-setup", icon: UserCog, label: "Contractor Setup" },
  { href: "/reports", icon: FileText, label: "Reports" },
  { href: "/turnaround", icon: Timer, label: "Turn Around Time" },
  { href: "/stuck", icon: Gauge, label: "Stuck Projects" },
  { href: "/completed", icon: CheckCircle2, label: "Completed" },
  { href: "/ageing", icon: Clock, label: "Ageing" },
  { href: "/data", icon: Database, label: "Data" },
  { href: "/thickness", icon: Layers, label: "Thickness" },
  { href: "/warning-parameters", icon: SlidersHorizontal, label: "Warning Params" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { selectedImportId } = useTracker();
  const showFilters =
    location !== "/data" &&
    location !== "/jobs" &&
    location !== "/warning-parameters" &&
    selectedImportId != null;

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background text-foreground pb-16 md:pb-0 md:pt-14">
      {/* Top Nav (Desktop) */}
      <header className="hidden md:flex fixed top-0 left-0 right-0 h-14 bg-sidebar border-b border-sidebar-border z-40 items-center px-4">
        <div className="font-bold text-lg text-primary mr-8 tracking-tight">TRACKER</div>
        <nav className="flex space-x-1">
          {navItems.map((item) => (
            <Link key={item.href} href={item.href}>
              <div className={`px-4 py-2 rounded-md text-sm font-medium transition-colors cursor-pointer ${
                location === item.href ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground hover:bg-sidebar-accent/50"
              }`}>
                {item.label}
              </div>
            </Link>
          ))}
        </nav>
      </header>

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

function FilterBar() {
  const { filters, setFilter, clearFilters, selectedImportId } = useTracker();
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

  // Rows narrowed by the active PRIMARY-dimension selection(s), so the
  // secondary option lists (Contractor / Activity / Mark) only offer values
  // that actually exist within the current drill-down.
  const scopedRecords = useMemo(
    () => modeRecords.filter(r => isNtlt
      ? (!filters.ntltSubtype || r.ntltSubtype === filters.ntltSubtype) &&
        (!filters.section || r.groupKey === filters.section)
      : (!filters.job || r.job === filters.job) &&
        (!filters.structure || r.structure === filters.structure)),
    [modeRecords, isNtlt, filters.ntltSubtype, filters.section, filters.job, filters.structure]
  );

  // TLT primary dimension = Project (job).
  const jobs = useMemo(
    () => Array.from(new Set(modeRecords.map(r => r.job).filter(Boolean))).sort(),
    [modeRecords]
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
      .filter(r => !filters.job || r.job === filters.job)
      .map(r => r.structure)
      .filter(Boolean)
    )).sort(),
    [modeRecords, filters.job]
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
      .filter(b => (isNtlt ? b.scope === "ALL" : true))
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
        <div className="flex items-center gap-2 p-3 md:px-6 pb-0 flex-wrap">
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
        </div>
        <div className="flex items-center justify-between p-3 md:px-6">
          <div className="flex items-center gap-2 flex-1 mr-4 flex-wrap">
            {/* In ALL mode isNtlt is false, so this defaults to the Job picker —
               the primary TLT dimension — which is what users expect when "All"
               order types are shown. NTLT mode swaps it for the Section picker. */}
            <div className="w-full sm:w-[260px]">
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
                  value={filters.job}
                  onChange={(v) => setFilter("job", v)}
                  options={jobs}
                  allLabel="All Jobs"
                  searchPlaceholder="Search jobs..."
                />
              )}
            </div>
            <div className="w-[200px]">
              <SearchableSelect
                value={filters.activity}
                onChange={(v) => setFilter("activity", v)}
                groups={activityGroups}
                allLabel="All Activities"
                searchPlaceholder="Search activities or bundles..."
              />
            </div>
            <div className="flex-1 min-w-[200px] max-w-[360px]">
              <SearchableSelect
                value={filters.contractor}
                onChange={(v) => setFilter("contractor", v)}
                options={contractors}
                allLabel="All Contractors"
                searchPlaceholder="Search contractors..."
              />
            </div>
            <DateRangeSelect className="h-9 w-[170px]" />
          </div>
          <div className="flex items-center gap-2">
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
              <label className="text-xs font-semibold text-muted-foreground uppercase">Contractor Type</label>
              <SearchableSelect
                value={filters.contractorCategory}
                onChange={(v) => setFilter("contractorCategory", v)}
                groups={[{ options: CONTRACTOR_CATEGORIES.map((c) => ({ value: c.value, label: c.label })) }]}
                allLabel="All Contractor Types"
                searchPlaceholder="Search contractor types..."
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
    </div>
  );
}
