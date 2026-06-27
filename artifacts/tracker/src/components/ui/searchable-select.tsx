import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

// A single selectable entry whose display label may differ from its machine
// value (used by bundle shortcuts, where the value is a "bundle:<id>" sentinel).
export interface SelectOption {
  value: string;
  label: string;
}

// An optionally-headed group of options (e.g. "Bundles" then "Activities").
export interface SelectGroup {
  heading?: string;
  options: SelectOption[];
}

interface SearchableSelectProps {
  value: string | null;
  onChange: (value: string | null) => void;
  // Back-compat: a plain string[] (value === label). Prefer `groups` for grouped
  // or label-distinct options. Exactly one of `options`/`groups` should be set.
  options?: string[];
  groups?: SelectGroup[];
  allLabel: string;
  searchPlaceholder?: string;
  disabled?: boolean;
}

export function SearchableSelect({
  value,
  onChange,
  options,
  groups,
  allLabel,
  searchPlaceholder = "Search...",
  disabled,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);

  // Normalize the back-compat string[] form into a single unheaded group.
  const resolvedGroups: SelectGroup[] = groups ?? [
    { options: (options ?? []).map((o) => ({ value: o, label: o })) },
  ];

  // Resolve the trigger label from the selected machine value.
  let selectedLabel = allLabel;
  if (value !== null) {
    selectedLabel = value;
    for (const g of resolvedGroups) {
      const found = g.options.find((o) => o.value === value);
      if (found) {
        selectedLabel = found.label;
        break;
      }
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="h-9 w-full justify-between bg-background text-sm font-normal"
        >
          <span className="truncate">{selectedLabel}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
      >
        <Command>
          <CommandInput placeholder={searchPlaceholder} className="h-9" />
          <CommandList className="max-h-[260px] overflow-y-auto">
            <CommandEmpty>No results.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value={allLabel}
                onSelect={() => {
                  onChange(null);
                  setOpen(false);
                }}
              >
                <Check
                  className={cn(
                    "mr-2 h-4 w-4",
                    value === null ? "opacity-100" : "opacity-0",
                  )}
                />
                {allLabel}
              </CommandItem>
            </CommandGroup>
            {resolvedGroups.map((group, gi) => (
              <CommandGroup key={group.heading ?? `g${gi}`} heading={group.heading}>
                {group.options.map((opt) => (
                  <CommandItem
                    // Search matches both the display label and the raw value
                    // (so a bundle is findable by name and a code by code).
                    key={opt.value}
                    value={`${opt.label} ${opt.value}`}
                    onSelect={() => {
                      onChange(opt.value);
                      setOpen(false);
                    }}
                    className="items-start"
                  >
                    <Check
                      className={cn(
                        "mr-2 mt-0.5 h-4 w-4 shrink-0",
                        value === opt.value ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="whitespace-normal break-words">{opt.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
