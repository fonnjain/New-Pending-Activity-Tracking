import React, { useState, useMemo } from "react";
import { Link, useLocation } from "wouter";
import { BarChart3, Activity, Clock, Users, Database, Filter, X } from "lucide-react";
import { useTracker } from "@/lib/store";
import { useListSnapshots, useGetSnapshotRecords, getGetSnapshotRecordsQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

const navItems = [
  { href: "/", icon: BarChart3, label: "Overview" },
  { href: "/activity", icon: Activity, label: "Activity" },
  { href: "/ageing", icon: Clock, label: "Ageing" },
  { href: "/contractor", icon: Users, label: "Contractor" },
  { href: "/data", icon: Database, label: "Data" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { selectedSnapshotId } = useTracker();
  const showFilters = location !== "/data" && selectedSnapshotId != null;

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
      <nav className="md:hidden fixed bottom-0 left-0 right-0 h-16 bg-sidebar border-t border-sidebar-border z-50 flex items-center justify-around pb-safe">
        {navItems.map((item) => {
          const isActive = location === item.href;
          const Icon = item.icon;
          return (
            <Link key={item.href} href={item.href}>
              <div className={`flex flex-col items-center justify-center w-16 h-full cursor-pointer transition-colors ${
                isActive ? "text-primary" : "text-sidebar-foreground/70 hover:text-sidebar-foreground"
              }`}>
                <Icon className="h-5 w-5 mb-1" strokeWidth={isActive ? 2.5 : 2} />
                <span className="text-[10px] font-medium">{item.label}</span>
              </div>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

function FilterBar() {
  const { filters, setFilter, clearFilters, selectedSnapshotId } = useTracker();
  const [isOpen, setIsOpen] = useState(false);
  const { data: records = [] } = useGetSnapshotRecords(selectedSnapshotId as number, {
    query: { enabled: !!selectedSnapshotId, queryKey: getGetSnapshotRecordsQueryKey(selectedSnapshotId as number) }
  });

  const jobs = useMemo(
    () => Array.from(new Set(records.map(r => r.job).filter(Boolean))).sort(),
    [records]
  );

  const structures = useMemo(
    () => Array.from(new Set(records
      .filter(r => !filters.job || r.job === filters.job)
      .map(r => r.structure)
      .filter(Boolean)
    )).sort(),
    [records, filters.job]
  );

  const marks = useMemo(
    () => Array.from(new Set(records
      .filter(r => (!filters.job || r.job === filters.job) && (!filters.structure || r.structure === filters.structure))
      .map(r => r.markId) // Simplified for UI
      .filter(Boolean)
    )).sort(),
    [records, filters.job, filters.structure]
  );

  const contractors = useMemo(
    () => Array.from(new Set(records.map(r => r.contractor).filter((c): c is string => Boolean(c)))).sort(),
    [records]
  );

  const activities = useMemo(
    () => Array.from(new Set(records.map(r => r.activity).filter((a): a is string => Boolean(a)))).sort(),
    [records]
  );

  const activeFilterCount = Object.values(filters).filter(v => v !== null && v !== "").length;

  return (
    <div className="sticky top-0 md:top-14 z-30 bg-card border-b shadow-sm">
      <Collapsible open={isOpen} onOpenChange={setIsOpen} className="w-full">
        <div className="flex items-center justify-between p-3 md:px-6">
          <div className="flex items-center gap-2 flex-1 mr-4">
            <Input 
              placeholder="Search marks, sections..." 
              value={filters.search}
              onChange={(e) => setFilter("search", e.target.value)}
              className="max-w-[300px] h-9"
            />
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
          <div className="p-3 md:px-6 pt-0 border-t bg-muted/30 grid grid-cols-2 md:grid-cols-5 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-semibold text-muted-foreground uppercase">Job</label>
              <Select value={filters.job || "all"} onValueChange={(v) => setFilter("job", v === "all" ? null : v)}>
                <SelectTrigger className="h-8 text-sm bg-background"><SelectValue placeholder="All Jobs" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Jobs</SelectItem>
                  {jobs.map(j => <SelectItem key={j} value={j}>{j}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-muted-foreground uppercase">Structure</label>
              <Select value={filters.structure || "all"} onValueChange={(v) => setFilter("structure", v === "all" ? null : v)} disabled={structures.length === 0}>
                <SelectTrigger className="h-8 text-sm bg-background"><SelectValue placeholder="All Structures" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Structures</SelectItem>
                  {structures.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-muted-foreground uppercase">Mark</label>
              <Select value={filters.mark || "all"} onValueChange={(v) => setFilter("mark", v === "all" ? null : v)} disabled={marks.length === 0}>
                <SelectTrigger className="h-8 text-sm bg-background"><SelectValue placeholder="All Marks" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Marks</SelectItem>
                  {marks.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-muted-foreground uppercase">Contractor</label>
              <Select value={filters.contractor || "all"} onValueChange={(v) => setFilter("contractor", v === "all" ? null : v)}>
                <SelectTrigger className="h-8 text-sm bg-background"><SelectValue placeholder="All Contractors" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Contractors</SelectItem>
                  {contractors.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 col-span-2 md:col-span-1">
              <label className="text-xs font-semibold text-muted-foreground uppercase">Activity</label>
              <Select value={filters.activity || "all"} onValueChange={(v) => setFilter("activity", v === "all" ? null : v)}>
                <SelectTrigger className="h-8 text-sm bg-background"><SelectValue placeholder="All Activities" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Activities</SelectItem>
                  {activities.map(a => <SelectItem key={a} value={a}>{a}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
