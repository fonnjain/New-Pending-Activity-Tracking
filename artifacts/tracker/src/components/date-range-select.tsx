import { useTracker } from "@/lib/store";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function DateRangeSelect({ className }: { className?: string }) {
  const { filters, setFilter } = useTracker();
  const year = new Date().getFullYear();

  const presets = [
    { code: "3m", label: "Last 3 Months" },
    { code: "6m", label: "Last 6 Months" },
    { code: "9m", label: "Last 9 Months" },
    { code: "1y", label: "Last 1 Year" },
    { code: "q1", label: `Q1 ${year} (Jan-Mar)` },
    { code: "q2", label: `Q2 ${year} (Apr-Jun)` },
    { code: "q3", label: `Q3 ${year} (Jul-Sep)` },
    { code: "q4", label: `Q4 ${year} (Oct-Dec)` },
  ];

  return (
    <Select
      value={filters.dateRange ?? "all"}
      onValueChange={(v) => setFilter("dateRange", v === "all" ? null : v)}
    >
      <SelectTrigger className={className ?? "h-9 w-full"}>
        <SelectValue placeholder="All Dates" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All Dates</SelectItem>
        {presets.map((p) => (
          <SelectItem key={p.code} value={p.code}>
            {p.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
