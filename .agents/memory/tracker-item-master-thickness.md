---
name: Item master as primary thickness source
description: Architecture, matching algorithm, and known conflicts for the item_master table used as the primary thickness source in resolveThickness().
---

## What was built

A new `item_master` DB table and a two-stage matching algorithm that uses the VTPL item master XLS as the primary thickness source for ALL section types (channels, beams, pipes, RSJ poles, etc.).

## Resolution order (resolveThickness)

1. manual pin → "manual"
2. master exact key lookup → "master"  (trim + uppercase + collapse whitespace, no bracket stripping)
3. master stripped key lookup → "master"  (brackets/unit tokens stripped, no RSJ prefix forced)
4. sectionThickness parse (TLT/EARTHING only — angle last-dim / plate MM)
5. rsj_thickness admin table (NTLT/RSJ only) → "rsj_exact"
6. rsj_base (built from master RSJ entries + admin table combined) → "rsj_base"
7. rsj_default (6.0 mm) → "rsj_default"
8. unset

## Matching algorithm rationale

- **Exact key first**: brackets are meaningful for PIPE sections (they encode OD/wall-thickness). Stripping them collapses distinct items. Matching WIP Section verbatim against master Item Name resolves both PIPE and RSJ correctly.
- **Stripped fallback**: for WIP sections that don't carry bracket text (e.g. bare "RSJ 150X150"), the stripped key resolves against master entries after stripping.
- **FG JOB WORK excluded**: master rows with groupName = "FG JOB WORK" are excluded from both maps to prevent finished-goods entries colliding with RSJ POLE raw-material entries after stripping.

## Known conflicts (stripped map — 8 entries)

These conflict in the stripped map but resolve correctly via exact key:
- RSJ 152X152X11, RSJ 152X152X13, RSJ 152X152X9.1 — variants [37.1] vs [34.5/34.6] collapse after stripping. WIP carries [37.1] → exact key resolves to 8 mm.
- RSJ 150X150 — FG JOB WORK row excluded, but there may be other RSJ entries that strip to same key. Resolves 9 mm via exact key (RM08010063).
- PIPE 200 N.B, PIPE 300 N.B, PIPE 50 N.B., PIPE 150NB — different wall variants collapse after stripping. WIP carries brackets → resolves via exact key.

## Expected gaps (WIP sections not in master → UNRESOLVED)

Per user confirmation:
- `PIPE 150NB [168.3 OD & 6.3 THK] MS` — different OD/wall from master entries. Gap.
- Any `A `-prefixed TLT angle sections (e.g. `A 200X200X20 MS`) — "A " prefix means master won't exact-match; falls through to section parse (angle last-dim). ✓ Correct fallback.
- ISMC/ISMB channels and beams — not in master thickness subset → fall through to section parse (which returns null for these) → "unset".

**Why:** The master's 672 non-JW thickness rows cover pipes, RSJ, flat, and some angles. Channels/beams have no thickness in the master.

## Stats after loading 25,321-row master

- 25,321 total rows
- 672 non-JW rows with thickness (excluding FG JOB WORK)
- 616 exact map entries (0 conflicts)
- 580 stripped map entries (8 conflicts, all resolved via exact key first)

## API endpoints

- `POST /api/item-master/upload` — multipart XLS/XLSX; requires auth; upserts all rows; clears thickness cache
- `GET /api/item-master/stats` — public; returns { totalRows, rowsWithThickness, lastUploadedAt }

## Key normalizers (exported from @workspace/domain)

- `normalizeItemExactKey(s)` — trim + uppercase + collapse whitespace
- `normalizeItemStrippedKey(s)` — same as cleanRsjGroupKey but without forcing RSJ prefix

## Upload UI

- `ItemMasterUploadCard` component in data.tsx (Data tab), shows stats + file picker
- Independent of WIP imports; can be re-uploaded any time; re-upload = UPSERT ON CONFLICT UPDATE

## ThicknessSource

Added `"master"` to the union type and SOURCE_LABEL in thickness.tsx ("Item master").
