/**
 * Resolve the canonical calendar day for a WIP import.
 *
 * A user-selected report date is an explicit operator decision and therefore
 * wins over a date inferred from the file name or banner. Older direct uploads
 * use the inference only when the operator did not select a date.
 */
export function resolveWipImportDate(
  selectedReportDate: string | null,
  detectedFileDate: string | null,
  fallbackToday: string,
): string {
  return selectedReportDate ?? detectedFileDate ?? fallbackToday;
}