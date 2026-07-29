import { cn } from "@/lib/utils";

export function Segmented({
  value,
  onChange,
  options,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  options: { value: string | null; label: string; disabled?: boolean }[];
}) {
  return (
    <div className="inline-flex rounded-md border bg-background p-0.5">
      {options.map((opt) => {
        const active = value === opt.value;
        const disabled = opt.disabled ?? false;
        return (
          <button
            key={opt.label}
            type="button"
            disabled={disabled}
            onClick={() => !disabled && onChange(opt.value)}
            title={disabled ? "Coming soon" : undefined}
            className={cn(
              "h-8 rounded-[5px] px-3 text-sm transition-colors",
              disabled
                ? "cursor-not-allowed opacity-40 text-muted-foreground"
                : active
                  ? "bg-primary text-primary-foreground font-medium"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
