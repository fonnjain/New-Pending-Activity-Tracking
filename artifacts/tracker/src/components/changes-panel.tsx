import { useMemo, useState } from "react";
import {
  useListImports,
  useGetImportChanges,
  useCompareImports,
  getGetImportChangesQueryKey,
  getCompareImportsQueryKey,
  type ChangeSet,
  type ChangeItem,
} from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { formatTons } from "@/lib/utils";

type Tab = "movedActivity" | "qtyChanged" | "newMarks" | "completed";

const TAB_LABELS: Record<Tab, string> = {
  movedActivity: "Moved activity",
  qtyChanged: "Qty / Wt changed",
  newMarks: "New marks",
  completed: "Completed",
};

export function ChangesPanel({ importId }: { importId: number }) {
  const { data: imports = [] } = useListImports();

  // imports are newest-first; default comparison is current vs the one before it.
  const defaultPrevId = useMemo(() => {
    const idx = imports.findIndex((i) => i.id === importId);
    if (idx === -1) return null;
    const prev = imports[idx + 1];
    return prev ? prev.id : null;
  }, [imports, importId]);

  const [fromId, setFromId] = useState<number | null>(null);
  const [toId, setToId] = useState<number | null>(null);

  const effectiveTo = toId ?? importId;
  const effectiveFrom = fromId ?? defaultPrevId;

  // When comparing the very first import (no base), the per-import changes
  // endpoint already reports every mark as new.
  const useCompare = effectiveFrom !== null;

  const changesQuery = useGetImportChanges(effectiveTo, {
    query: {
      enabled: !useCompare,
      queryKey: getGetImportChangesQueryKey(effectiveTo),
    },
  });

  const compareParams = { from: effectiveFrom ?? 0, to: effectiveTo };
  const compareQuery = useCompareImports(compareParams, {
    query: {
      enabled: useCompare,
      queryKey: getCompareImportsQueryKey(compareParams),
    },
  });

  const changeSet: ChangeSet | undefined = useCompare
    ? compareQuery.data
    : changesQuery.data;

  const [tab, setTab] = useState<Tab>("movedActivity");

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base uppercase tracking-wider text-muted-foreground flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <span>Changes since last upload</span>
          {imports.length > 1 && (
            <div className="flex items-center gap-2 text-xs font-normal normal-case">
              <span className="text-muted-foreground">Compare</span>
              <select
                className="bg-background border border-border rounded-md px-2 py-1 max-w-[10rem]"
                value={effectiveFrom ?? ""}
                onChange={(e) =>
                  setFromId(e.target.value ? Number(e.target.value) : null)
                }
              >
                <option value="">(first import)</option>
                {imports.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.label || i.sourceFilename}
                  </option>
                ))}
              </select>
              <span className="text-muted-foreground">to</span>
              <select
                className="bg-background border border-border rounded-md px-2 py-1 max-w-[10rem]"
                value={effectiveTo}
                onChange={(e) => setToId(Number(e.target.value))}
              >
                {imports.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.label || i.sourceFilename}
                  </option>
                ))}
              </select>
            </div>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!changeSet ? (
          <div className="text-sm text-muted-foreground">Computing changes...</div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Chip label="New marks" value={changeSet.counts.newMarks} tone="emerald" />
              <Chip label="Completed" value={changeSet.counts.completed} tone="slate" />
              <Chip label="Moved activity" value={changeSet.counts.movedActivity} tone="blue" />
              <Chip label="Qty / Wt changed" value={changeSet.counts.qtyChanged} tone="amber" />
              <Chip label="Added rows" value={changeSet.counts.addedRows} tone="emerald" />
              <Chip
                label="Net pending qty"
                value={signed(changeSet.netPendingQtyChange)}
                tone={changeSet.netPendingQtyChange <= 0 ? "emerald" : "red"}
              />
              <Chip
                label="Net pending wt (t)"
                value={signedTons(changeSet.netPendingWtChange)}
                tone={changeSet.netPendingWtChange <= 0 ? "emerald" : "red"}
              />
            </div>

            {changeSet.flags.length > 0 && (
              <div className="space-y-1">
                {changeSet.flags.map((f, i) => (
                  <div
                    key={i}
                    className="text-xs flex items-start gap-2 text-amber-700 dark:text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-md px-3 py-2"
                  >
                    <span className="font-bold mt-px">!</span>
                    <span>{f}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-wrap gap-1 border-b border-border">
              {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-3 py-2 text-xs font-semibold uppercase tracking-wider border-b-2 -mb-px transition-colors ${
                    tab === t
                      ? "border-primary text-primary"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {TAB_LABELS[t]} ({changeSet[t].length})
                </button>
              ))}
            </div>

            <ChangeTable items={changeSet[tab]} tab={tab} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ChangeTable({ items, tab }: { items: ChangeItem[]; tab: Tab }) {
  if (items.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-6 text-center">
        No marks in this category.
      </div>
    );
  }

  const showActivity = tab === "movedActivity";
  const showQty = tab === "qtyChanged";

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
            <th className="py-2 pr-4 font-semibold">Mark</th>
            <th className="py-2 pr-4 font-semibold">Contractor</th>
            {showActivity && <th className="py-2 pr-4 font-semibold">From</th>}
            {showActivity && <th className="py-2 pr-4 font-semibold">To</th>}
            {showQty && <th className="py-2 pr-4 font-semibold text-right">Qty</th>}
            {showQty && <th className="py-2 pr-4 font-semibold text-right">Wt (t)</th>}
            {!showActivity && !showQty && (
              <th className="py-2 pr-4 font-semibold text-right">Qty</th>
            )}
            {!showActivity && !showQty && (
              <th className="py-2 pr-4 font-semibold text-right">Wt (t)</th>
            )}
          </tr>
        </thead>
        <tbody>
          {items.slice(0, 200).map((it) => (
            <tr key={it.markId} className="border-b border-border/50 hover:bg-muted/30">
              <td className="py-2 pr-4 font-mono text-xs">{it.markId}</td>
              <td className="py-2 pr-4">{it.contractor || "Unassigned"}</td>
              {showActivity && (
                <td className="py-2 pr-4 text-muted-foreground">
                  {it.activityFrom || "—"}
                </td>
              )}
              {showActivity && (
                <td className="py-2 pr-4 font-medium">{it.activityTo || "—"}</td>
              )}
              {showQty && (
                <td className="py-2 pr-4 text-right tabular-nums">
                  {fmt(it.qtyFrom)} → {fmt(it.qtyTo)}
                </td>
              )}
              {showQty && (
                <td className="py-2 pr-4 text-right tabular-nums">
                  {fmtTons(it.wtFrom)} → {fmtTons(it.wtTo)}
                </td>
              )}
              {!showActivity && !showQty && (
                <td className="py-2 pr-4 text-right tabular-nums">
                  {fmt(it.qtyTo ?? it.qtyFrom)}
                </td>
              )}
              {!showActivity && !showQty && (
                <td className="py-2 pr-4 text-right tabular-nums">
                  {fmtTons(it.wtTo ?? it.wtFrom)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {items.length > 200 && (
        <div className="text-xs text-muted-foreground pt-2">
          Showing first 200 of {items.length.toLocaleString()}.
        </div>
      )}
    </div>
  );
}

const TONES: Record<string, string> = {
  emerald: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
  red: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20",
  amber: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
  blue: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20",
  slate: "bg-muted text-muted-foreground border-border",
};

function Chip({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone: keyof typeof TONES;
}) {
  return (
    <div className={`rounded-md border px-3 py-1.5 ${TONES[tone]}`}>
      <span className="text-[10px] uppercase tracking-wider opacity-80 block">
        {label}
      </span>
      <span className="font-bold tabular-nums text-sm">{value}</span>
    </div>
  );
}

function fmt(n: number | null): string {
  if (n === null) return "—";
  return n.toLocaleString();
}

function fmtTons(n: number | null): string {
  if (n === null) return "—";
  return formatTons(n);
}

function signed(n: number): string {
  const s = n.toLocaleString();
  return n > 0 ? `+${s}` : s;
}

function signedTons(n: number): string {
  const s = formatTons(Math.abs(n));
  return n > 0 ? `+${s}` : n < 0 ? `-${s}` : s;
}
