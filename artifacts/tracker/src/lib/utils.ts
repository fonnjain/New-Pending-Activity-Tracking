import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Format a weight (in kilograms) with its unit. Weights under 100 kg are shown
// in kilograms rounded to the nearest integer (e.g. "85 kg"). 100 kg and above
// are shown in metric tons with one decimal place (e.g. "0.9 t", "2.0 t").
// The 100 kg threshold keeps columns consistent — production items are always
// ≥ 100 kg so the unit never flips mid-column.
export function formatWeight(kg: number): string {
  if (Math.abs(kg) < 100) {
    return `${Math.round(kg).toLocaleString()} kg`;
  }
  return `${(kg / 1000).toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}t`;
}

// Format a weight (in kilograms) always in metric tons (MT), with two decimal
// places (e.g. "2.92 MT", "0.85 MT"). Used where a report needs one
// consistent unit throughout instead of the kg/t auto-switching of
// formatWeight (e.g. the Contractor Performance report).
export function formatWeightMT(kg: number): string {
  return `${(kg / 1000).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} MT`;
}

// Format any date value as dd-mm-yyyy for display. Accepts a "YYYY-MM-DD" day
// key (assignDate/lastProductionDate/reportDate — parsed as a plain calendar
// date, no timezone conversion), a full ISO datetime (createdAt), or a Date
// instance. Returns "-" for null/blank/unparseable input. Display-only: never
// use this for stored values, filter keys, or hashing.
export function formatDate(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) return "-";
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return "-";
    return `${String(value.getDate()).padStart(2, "0")}-${String(value.getMonth() + 1).padStart(2, "0")}-${value.getFullYear()}`;
  }
  const s = value.trim();
  if (!s) return "-";
  const dayKeyMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dayKeyMatch) {
    const [, y, m, d] = dayKeyMatch;
    return `${d}-${m}-${y}`;
  }
  const parsed = new Date(s);
  if (isNaN(parsed.getTime())) return "-";
  return `${String(parsed.getDate()).padStart(2, "0")}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${parsed.getFullYear()}`;
}

// Like formatDate but also appends the local time, for full-timestamp fields
// (e.g. "Generated at" / createdAt shown with time). Date portion is always
// dd-mm-yyyy; returns "-" for null/blank/unparseable input.
export function formatDateTime(value: string | Date | null | undefined): string {
  const datePart = formatDate(value);
  if (datePart === "-") return "-";
  const d = value instanceof Date ? value : new Date(value as string);
  if (isNaN(d.getTime())) return datePart;
  return `${datePart} ${d.toLocaleTimeString()}`;
}
