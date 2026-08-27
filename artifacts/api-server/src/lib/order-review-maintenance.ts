const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export type OrderReviewDeletionCleanup =
  | "clear-order-book-and-dispatch"
  | "remove-deleted-last-seen-rows";

/**
 * Deleting a merged Order Review snapshot cannot reconstruct an older value for
 * a key. Preserve truthful attribution by removing rows that were last seen in
 * the deleted file; only a completely empty history clears the entire overlay.
 */
export function orderReviewDeletionCleanup(
  remainingImportCount: number,
): OrderReviewDeletionCleanup {
  return remainingImportCount === 0
    ? "clear-order-book-and-dispatch"
    : "remove-deleted-last-seen-rows";
}

export function hasRecentCumulativeOverride(
  overrideAt: Date | string | null | undefined,
  now = new Date(),
): boolean {
  if (!overrideAt) return false;
  const acceptedAt =
    overrideAt instanceof Date ? overrideAt.getTime() : Date.parse(overrideAt);
  return Number.isFinite(acceptedAt) && acceptedAt <= now.getTime() &&
    now.getTime() - acceptedAt <= SEVEN_DAYS_MS;
}