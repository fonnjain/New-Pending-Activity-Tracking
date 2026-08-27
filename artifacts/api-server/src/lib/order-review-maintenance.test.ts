import assert from "node:assert/strict";
import test from "node:test";
import {
  hasRecentCumulativeOverride,
  orderReviewDeletionCleanup,
} from "./order-review-maintenance";

test("deleting an Order Review with surviving history removes its last-seen rows instead of repointing them", () => {
  assert.equal(orderReviewDeletionCleanup(2), "remove-deleted-last-seen-rows");
  assert.equal(orderReviewDeletionCleanup(1), "remove-deleted-last-seen-rows");
});

test("deleting the final Order Review clears the whole overlay", () => {
  assert.equal(orderReviewDeletionCleanup(0), "clear-order-book-and-dispatch");
});

test("recent cumulative override warnings cover the prior seven calendar days only", () => {
  const now = new Date("2026-08-24T12:00:00.000Z");
  assert.equal(
    hasRecentCumulativeOverride("2026-08-17T12:00:00.000Z", now),
    true,
  );
  assert.equal(
    hasRecentCumulativeOverride("2026-08-17T11:59:59.999Z", now),
    false,
  );
  assert.equal(
    hasRecentCumulativeOverride("2026-08-25T12:00:00.000Z", now),
    false,
  );
});