---
name: Sticky table header/footer in tracker
description: How to make a table's header/footer stick (and totals stay visible) given the shared ui/table.tsx wrapper.
---

# Sticky header/footer + scrollable detail tables

The shared `artifacts/tracker/src/components/ui/table.tsx` `Table` renders the
`<table>` inside its OWN `<div className="relative w-full overflow-auto">`.

**Rule:** to make a `TableHeader`/`TableFooter` sticky inside a height-capped
scroll area, the `max-h-*` cap MUST land on that internal wrapper — pass
`containerClassName` to `<Table>` (e.g. `containerClassName="max-h-[28rem]"`).
Capping an OUTER page-level div does nothing: the nearest scroll ancestor of
the sticky `thead`/`tfoot` is the internal `overflow-auto` div, so sticky pins
to that. An uncapped outer wrapper is fine (it shrinks to the bounded inner and
won't create a competing scroll container).

**Why:** detail tables render up to ROW_CAP (300) rows; without a capped,
sticky context the totals `<tfoot>` is buried far below the fold and looks like
it's "not showing".

**How to apply:** sticky header `className="sticky top-0 z-10 bg-card"` (use a
solid bg — `bg-muted` where the table body sits on `bg-muted/20`), sticky
footer `className="sticky bottom-0 z-10 bg-muted"` (solid bg overrides the
translucent `bg-muted/50` default so rows don't bleed through).
