---
name: In-Hand fabrication load Col Q route guard
description: Why upcoming ("In Hand") fab load must be gated on Col Q route membership, and the exact fallback rule.
---

# In-Hand fabrication load must respect the Col Q route

The "Fabrication Load for TLT" report/dashboard splits each operation into
Operational (work AT the activity now) and **In Hand** (positionally BEFORE the
activity in the sequence). Positional-only In-Hand over-counts: a mark before W
in the sequence may never weld because W is not in its route.

**Rule:** In-Hand load for a standard op (W, B) counts a mark ONLY IF the mark is
positionally before the op AND the op is in the mark's Col Q "Operation" route.

**Why:** Col Q lists the mark's FULL required route (e.g. "C,P,S,RFI,Q,G,GB").
A mark at RFI with no W in Col Q will never weld, so counting it as Welding
In Hand is wrong. Real data had ~30k such over-counted marks per op.

**How to apply:**
- Helpers live in `@workspace/domain`: `routeOps(operation)` parses Col Q
  (comma-split, trim/uppercase) intersected with the union of ALL sequence codes
  (drops non-standard tokens P,S,D,N,BL,...). `routeIncludesOp(operation, op)` is
  the guard.
- Fallback is BLANK-ONLY: null/empty/whitespace Col Q returns true (keep prior
  positional behaviour, never silently zero a mark). A non-blank route that lacks
  the op — even one with only non-standard tokens — returns false.
- Guard the IN-HAND path ONLY. Do NOT touch Operational load (a mark AT W is by
  definition welding), punching/drilling (section + thickness, never re-derived
  from Col Q), or the hole/quality in-hand paths. Col Q is a membership lookup for
  standard operations only — never track/display non-standard codes.
- Col Q is the stored `operation` field (recordPool + serialized in /records);
  it is display/derived, never in the dedup hash.
