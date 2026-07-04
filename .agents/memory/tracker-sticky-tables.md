---
name: Sticky table headers in tracker
description: Sticky column headers are the app-wide default; the one pattern that works here and why.
---

# Sticky table headers (app-wide default)

Column headers must stay visible while scrolling ANY table. The only reliable pattern in this app is **internal scroll**: a height-capped `overflow-auto` container is the sticky element's scroll ancestor, with a sticky `thead` (and sticky `tfoot` for totals) that has a SOLID/opaque background.

**Why not page/viewport sticky:** the app has a sticky top nav (`md:top-14`) and per-page sticky filter bars, and wide tables need a horizontal-overflow wrapper. An `overflow-x` wrapper makes `overflow-y` compute to `auto`, so that wrapper — not the window — becomes the sticky element's scroll ancestor. Viewport-level sticky therefore can't work; capping the wrapper's height and pinning inside it is what works.

**How to apply:**
- Prefer the shared `ui/table.tsx` `<Table>` — sticky header + a default height cap are baked in (both overridable via `containerClassName` / `TableHeader` `className`; `cn` uses twMerge so consumer overrides win).
- For a raw `<table>`: wrap in `overflow-auto` + a `max-h` cap, and give the `<thead>` sticky + an OPAQUE bg. Translucent bg (e.g. `bg-muted/40`) bleeds — use the solid variant. If the bg lived on the header `<tr>`, add a solid bg to the `<thead>` too (sticky needs the bg on the sticky element).
- **border-collapse gotcha:** sticky `<thead>` cells lose their borders under `border-collapse`; use `border-separate border-spacing-0` instead.

**Tradeoff (accepted):** every capped table scrolls internally, so very tall tables create a nested/second scrollbar. If a specific table shouldn't cap, override its container cap rather than reverting the global default.
