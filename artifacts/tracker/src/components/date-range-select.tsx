import { useTracker } from "@/lib/store";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";

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

  const raw = filters.dateRange;
  const isCustom = !!raw && raw.startsWith("custom:");
  const [, customStart = "", customEnd = ""] = isCustom ? raw!.split(":") : [];

  const selectValue = isCustom ? "custom" : raw ?? "all";

  const onSelect = (v: string) => {
    if (v === "all") setFilter("dateRange", null);
    else if (v === "custom") setFilter("dateRange", "custom::");
    else setFilter("dateRange", v);
  };

  const setCustom = (s: string, e: string) => setFilter("dateRange", `custom:${s}:${e}`);

  return (
    <div className="flex flex-col gap-2">
      <Select value={selectValue} onValueChange={onSelect}>
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
          <SelectItem value="custom">Custom Range</SelectItem>
        </SelectContent>
      </Select>
      {isCustom && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <Input
            type="date"
            value={customStart}
            max={customEnd || undefined}
            onChange={(e) => setCustom(e.target.value, customEnd)}
            className="h-9 text-xs flex-1 min-w-[120px]"
            aria-label="Start date"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <Input
            type="date"
            value={customEnd}
            min={customStart || undefined}
            onChange={(e) => setCustom(customStart, e.target.value)}
            className="h-9 text-xs flex-1 min-w-[120px]"
            aria-label="End date"
          />
        </div>
      )}
    </div>
  );
}
