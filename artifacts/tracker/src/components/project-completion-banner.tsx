import { useMemo, useState } from "react";
import { useGetMilestones, getGetMilestonesQueryKey } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableFooter, TableHead,
  TableHeader, TableRow,
} from "@/components/ui/table";
import { CheckCircle2, Truck } from "lucide-react";
import { formatDate } from "@/lib/utils";

type Milestone = {
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
};

function varianceChip(v: number | null) {
  if (v === null) return <span className="text-muted-foreground">-</span>;
  if (v === 0) return <span className="text-emerald-600 font-medium">On plan</span>;
  const abs = Math.abs(v);
  if (v > 0)
    return <span className="text-ageing-red font-semibold">+{abs}d late</span>;
  return <span className="text-emerald-600 font-semibold">{v}d early</span>;
}

function StatusChip({ m }: { m: Milestone }) {
  if (m.dispatchedDate)
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide bg-emerald-50 text-emerald-700 border border-emerald-200 rounded px-1.5 py-0.5">
        <Truck className="w-3 h-3" /> Dispatched
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide bg-blue-50 text-blue-700 border border-blue-200 rounded px-1.5 py-0.5">
      <CheckCircle2 className="w-3 h-3" /> Ready
    </span>
  );
}

const VISIBLE_CAP = 5;

export function ProjectCompletionBanner() {
  const { data } = useGetMilestones({
    query: { queryKey: getGetMilestonesQueryKey() },
  });

  const [showAll, setShowAll] = useState(false);

  const sorted = useMemo<Milestone[]>(() => {
    if (!data?.items) return [];
    return (data.items as Milestone[])
      .filter((m) => m.readyDate != null)
      .sort((a, b) => {
        // Dispatched before Ready; within each group, most recent first
        if (a.dispatchedDate && !b.dispatchedDate) return -1;
        if (!a.dispatchedDate && b.dispatchedDate) return 1;
        const da = a.dispatchedDate ?? a.readyDate ?? "";
        const db = b.dispatchedDate ?? b.readyDate ?? "";
        return db.localeCompare(da);
      });
  }, [data]);

  const totalReady = sorted.length;
  const totalDispatched = sorted.filter((m) => m.dispatchedDate != null).length;
  const avgTat = useMemo(() => {
    const d = sorted.filter((m) => m.dispatchedTurnaroundDays != null);
    return d.length
      ? Math.round(d.reduce((s, m) => s + m.dispatchedTurnaroundDays!, 0) / d.length)
      : null;
  }, [sorted]);

  if (sorted.length === 0) return null;

  const visible = showAll ? sorted : sorted.slice(0, VISIBLE_CAP);

  return (
    <Card>
      <div className="px-4 pt-4 pb-2 flex flex-wrap items-center gap-x-6 gap-y-2">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Project Completion
        </h3>
        <div className="flex gap-4 flex-wrap">
          <div className="flex items-center gap-1.5 text-sm">
            <CheckCircle2 className="w-4 h-4 text-blue-500" />
            <span className="font-bold text-foreground">{totalReady}</span>
            <span className="text-muted-foreground">Ready</span>
          </div>
          <div className="flex items-center gap-1.5 text-sm">
            <Truck className="w-4 h-4 text-emerald-600" />
            <span className="font-bold text-foreground">{totalDispatched}</span>
            <span className="text-muted-foreground">Dispatched</span>
          </div>
          {avgTat != null && (
            <div className="flex items-center gap-1 text-sm">
              <span className="text-muted-foreground">Avg TAT:</span>
              <span className="font-bold text-foreground">{avgTat}d</span>
            </div>
          )}
        </div>
      </div>

      <CardContent className="pt-0 px-0 pb-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Project</TableHead>
                <TableHead className="text-center">Status</TableHead>
                <TableHead className="text-right whitespace-nowrap">Ready Date</TableHead>
                <TableHead className="text-right whitespace-nowrap">Dispatched</TableHead>
                <TableHead className="text-right whitespace-nowrap">TAT (days)</TableHead>
                <TableHead className="text-right whitespace-nowrap">vs Plan</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((m) => {
                const tat = m.dispatchedTurnaroundDays ?? m.readyTurnaroundDays;
                return (
                  <TableRow key={m.project}>
                    <TableCell className="font-medium max-w-[140px]">
                      <span className="block truncate" title={m.project}>{m.project}</span>
                      {m.reopened && (
                        <span className="text-[10px] text-amber-600 font-semibold">Reopened</span>
                      )}
                      {m.limitedHistory && (
                        <span className="text-[10px] text-muted-foreground">Limited history</span>
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      <StatusChip m={m} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm">
                      {m.readyDate ? formatDate(m.readyDate) : "-"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm">
                      {m.dispatchedDate ? formatDate(m.dispatchedDate) : "-"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-semibold">
                      {tat != null ? `${tat}d` : "-"}
                    </TableCell>
                    <TableCell className="text-right">
                      {varianceChip(m.varianceReadyDays)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
            {sorted.length > VISIBLE_CAP && (
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-2">
                    <button
                      type="button"
                      onClick={() => setShowAll((v) => !v)}
                      className="text-xs text-primary font-medium hover:underline"
                    >
                      {showAll
                        ? "Show less"
                        : `Show all ${sorted.length} completed projects`}
                    </button>
                  </TableCell>
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
