---
name: Tracker master home + /production nesting
description: Why the tracker lives under /production and how the VTPL master hub routes.
---

# VTPL master home + Production nesting

The tracker artifact serves a VTPL **master hub at `/`** (department tiles:
Production live; Quality/Engineering/Planning/Finance are coming-soon placeholders).
The entire original tracker is mounted under **`/production`** via a wouter v3
`<Route path="/production" nest>`.

**Why:** VTPL wants one master tracker with per-department workspaces; the existing
app became the "Production Activity Tracker" behind the Production tile.

**How to apply / gotchas:**
- Nesting means every existing internal `<Link href="/jobs">` etc. resolves
  relative to `/production` automatically — do NOT hardcode `/production` in nav.
- To escape back to the master root from inside the nested tracker, use wouter's
  absolute prefix: `<Link href="~/">` (plain `/` would resolve to `/production`).
- Legacy root paths (pre-nesting bookmarks like `/data`, `/jobs`) are kept working
  via `<Redirect>` routes at the outer router → `/production${path}`.
- New department workspaces should each get their own top-level nested route and a
  tile on the master home; keep the tracker changes strictly additive.
