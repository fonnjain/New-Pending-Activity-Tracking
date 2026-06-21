import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Format a weight (in kilograms) with its unit. Weights under 1 ton (1000 kg)
// are shown in kilograms (e.g. "850 kg"); 1 ton and above are shown in metric
// tons with one decimal place (e.g. "2.0 t"). Used everywhere weight is shown.
export function formatWeight(kg: number): string {
  if (Math.abs(kg) < 1000) {
    return `${Math.round(kg).toLocaleString()} kg`;
  }
  return `${(kg / 1000).toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} t`;
}
