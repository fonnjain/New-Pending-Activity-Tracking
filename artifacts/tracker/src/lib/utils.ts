import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Convert a weight in kilograms to metric tons (kg / 1000), formatted with
// thousands separators and one decimal place. Used everywhere weight is shown.
export function formatTons(kg: number): string {
  return (kg / 1000).toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}
