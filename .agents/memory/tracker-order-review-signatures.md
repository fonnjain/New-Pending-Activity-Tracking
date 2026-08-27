---
name: Order Review regression signatures
description: Defines the mutually exclusive labels used to explain already-blocking cumulative Order Review regressions.
---

Order Review signatures explain a blocker after it has been detected; they must never relax the cumulative-regression guard, its tolerance, or its warning/block split.

- **A — cancellation or scope transfer:** every cumulative column and WO Order Qty ends at zero within tolerance, with at least one actual decrease. Columns already at zero must still qualify.
- **B — correction:** WO Order Qty is unchanged, while cumulative progress falls and at least one cumulative column remains unchanged.
- **D — scope reduction:** WO Order Qty decreases but remains above tolerance, and at least one cumulative column decreases.
- **C — unclassified:** all other blocking patterns.

**Why:** Treating “falls to zero” as the cancellation test misclassified orders with already-zero later stages. Scope reductions need a distinct label because the order quantity itself shrinks while remaining non-zero.

**How to apply:** Keep A, B, and D mutually exclusive by using the same tolerance boundary for “ends at zero” and “remains above zero.” Display the label and normalized reason in the anomaly register, but derive blocking solely from the underlying regression list.