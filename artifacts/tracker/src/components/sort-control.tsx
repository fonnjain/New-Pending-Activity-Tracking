import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { RECORD_SORT_OPTIONS, type RecordSortKey } from "@/lib/sort";

export function SortControl({
  value,
  onChange,
  className,
}: {
  value: RecordSortKey;
  onChange: (value: RecordSortKey) => void;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-2 ${className ?? ""}`}>
      <label className="text-xs font-semibold text-muted-foreground uppercase whitespace-nowrap">
        Sort by
      </label>
      <Select value={value} onValueChange={(v) => onChange(v as RecordSortKey)}>
        <SelectTrigger className="h-9 w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {RECORD_SORT_OPTIONS.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
