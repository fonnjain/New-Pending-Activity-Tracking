---
name: Controlled numeric input caret/digit-reversal pattern
description: Why controlled type=number inputs reverse digits in this app and the NumberInput fix to use for any numeric field.
---

# Controlled `<input type="number">` reverses digits — use NumberInput

A controlled `<input type="number" value={parsedNumber} onChange={parse}>` reverses
multi-digit entry: typing `90` shows `09`, `70` shows `07`.

**Why:** the value fed back is the *parsed number*, so on each keystroke React's
controlled value can differ from the DOM string (e.g. a leading zero or a clamp),
forcing React to rewrite the input's `.value`. Browsers forbid caret restoration on
`type="number"` (`selectionStart` is null), so the caret jumps to position 0 and the
next digit lands in front.

**Fix (in this repo):** `artifacts/tracker/src/components/ui/number-input.tsx`
(`NumberInput`) holds the RAW typed string in local `draft` state while focused, so
the controlled value always equals the DOM string during typing (React never
rewrites it → caret preserved). It commits the raw string up via `onValueChange`
(parent still parses/clamps) and reflects the normalized numeric `value` back only on
blur. Handles `value: number | ""` (empty = placeholder/inherited).

**How to apply:** use `NumberInput` for ANY controlled numeric field, not a bare
`Input type="number"` bound to a parsed number. Switching to `type="text"
inputMode="numeric"` is an alternative but loses spinners; NumberInput keeps them.
