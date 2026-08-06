---
name: Fabrication Load for TLT — sections & columns
description: Three-section (Operation Load / In Hand / Upcoming) × six-column structure and per-mark routing rules.
---
- Columns (order): welded, anglePunch (Angle Punching), drilling (label "Angle Drilling" — stored key unchanged so saved priorities survive), platePunch, plateDrill, bending. Angle Punching = ANGLE + PUNCHING (RFI operational / C in-hand-or-upcoming), mirroring the plate pair.
- Sections are routed PER MARK, never by project totals: classifyWipCase()===NOT_RELEASED (Type "Job Card Not Started" + Status "Initial") → UPCOMING only; everything else → Operational/In Hand as before. Upcoming uses the same per-op rules as In Hand (positional + Col Q route guard for W/B; sectionType+holeOperation for hole columns).
- **Why:** Upcoming ADDS ~2,500 MT of previously-excluded unreleased work; it must stay disjoint from the other sections (a NOT_RELEASED mark with non-C activity would otherwise double-count in Operational).
- **How to apply:** any change to fabLoadMatch must keep the three sections a partition; exclusion of NOT_RELEASED from Operational/In Hand is unconditional, not activity-C-gated. Priorities API enums (openapi.yaml ×2 places) must match domain FAB_LOAD_SECTIONS/COLUMNS.
