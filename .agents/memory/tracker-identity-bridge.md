---
name: markId + jobCardNo identity bridge
description: Why fabrication-stage marks vanished from the movement ledger and change log, and how the bridge in identityBridge.ts fixes it without touching the documented identity convention.
---

The app tracks a mark across uploads with the compound identity `markId + jobCardNo` (documented invariant, used in `diff.ts` for the per-import change log and `contractorMovement.ts` for the Contractor Performance movement ledger).

Live-data investigation found the shop issues a **brand-new job card every time a TLT mark advances to its next fabrication operation** (`C→RFI`, `RFI→NH`, `Q→GB`, etc.) — confirmed by checking ~9,900 mark-to-mark transitions across 10 imports: ~9,173 were clean 1-old-card→1-new-card swaps, and literally 100% of those coincided with a real activity change (never a no-op re-card). Late-stage Galvanizing marks (`G`/`GB`) rarely get re-carded, so their movement always tracked fine — which is why reports looked like "Galvanizing only, Fabrication never shows."

**Why:** Keying continuity on `markId + jobCardNo` breaks the moment the job card changes — the old identity looks like it "disappeared" and the new one looks brand new, so the move is recorded nowhere.

**How to apply:** `identityBridge.ts` (`buildIdentityBridge`) detects, per markId per import transition, an *unambiguous* 1-lost-card → 1-new-card swap and maps the new raw key to the old one's canonical key. Ambiguous cases (0 or 2+ simultaneous candidates for the same markId, e.g. sibling copies with distinct job cards swapping at the same time) are deliberately left unbridged rather than guessed. `contractorMovement.ts` runs this across the full sequential import history (a mark's card can be reissued more than once); `diff.ts` runs it per adjacent import pair since it only ever compares two membership sets. Any other engine that ever needs cross-import mark continuity (milestones, dispatch, accumulated WIP) has the same underlying risk and was NOT touched by this fix — check whether it needs the same bridge before assuming its numbers are unaffected.
