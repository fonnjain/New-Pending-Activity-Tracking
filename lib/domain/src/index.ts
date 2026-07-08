// Canonical process-step sequence for steel-fabrication activities.
//
// This is the SINGLE SOURCE OF TRUTH for how activities are ordered everywhere
// in the app (dropdowns, dashboard cards, ageing tables, reports, exports, chart
// legends, AI validation). Do not define a second order list anywhere else —
// import from here instead.
//
// Order is intentional: W -> Q -> TS (Quality before Tee Stock). HG (Grinding)
// sits at position 2 (right after C, before RFI): it is grinding/finishing done
// on the cut piece before it is presented for inspection.
export const PROCESS_SEQUENCE = [
  "C",
  "HG",
  "RFI",
  "NH",
  "B",
  "HAB",
  "W",
  "Q",
  "TS",
  "G",
  "GB",
  "Y",
] as const;

export type ProcessStep = (typeof PROCESS_SEQUENCE)[number];

// ---------------------------------------------------------------------------
// Per-category process sequences (TLT vs NTLT subtypes)
// ---------------------------------------------------------------------------
// A mark's category determines WHICH ordered sequence of activities it travels
// through. TLT (towers/structures) keeps the canonical 12-step PROCESS_SEQUENCE
// above — it is `SEQUENCES.TLT` verbatim, so all existing TLT behaviour is
// byte-for-byte unchanged. NTLT items (RSJ poles, earthing, general) skip the
// tower-specific early stages and follow shorter routes. Every sequence still
// ends at "Y" (Yard) and shares the common tail TS -> G -> GB -> Y.
//
// This is display/ordering + target-accumulation only: it NEVER changes parsing,
// Activity values read from the file, quantities, ageing, or dedup.
export const SEQUENCES = {
  TLT: PROCESS_SEQUENCE,
  // RSJ poles: three NTLT-specific fit-up/weld steps, then the common tail.
  NTLT_RSJ: ["NTF", "NTFSW", "NTFW", "TS", "G", "GB", "Y"],
  // Earthing + General: just the common tail.
  NTLT_EARTHING: ["TS", "G", "GB", "Y"],
  NTLT_GENERAL: ["TS", "G", "GB", "Y"],
} as const;

export type SequenceKey = keyof typeof SEQUENCES;
// A process sequence is an ordered, read-only list of activity codes.
export type ActivitySequence = readonly string[];

// A mark's high-level category and (for NTLT) its subtype. Stored on each record
// by the parser; drives sequence selection. Kept loose (string) at the engine
// boundary so callers can pass raw DB values without coupling to enums.
export type MarkCategory = "TLT" | "NTLT";
export type NtltSubtype = "RSJ" | "EARTHING" | "GENERAL";

// Minimal shape the sequence helpers need from a record.
export interface CategorizedRecord {
  category?: string | null;
  ntltSubtype?: string | null;
}

// Human-readable labels for tooltips / reference only. NOT used for ordering and
// NOT a substitute for the Activity value read from the file.
export const PROCESS_STEP_LABELS: Record<ProcessStep, string> = {
  C: "Cutting",
  RFI: "Ready for Inspection",
  NH: "Notching / Hole",
  B: "Bending",
  HAB: "Heat / Assembly-Bending",
  HG: "Grinding",
  W: "Welding",
  Q: "Quality",
  TS: "Tee Stock",
  G: "Galvanizing",
  GB: "Galvanizing & Bundle",
  Y: "Yard",
};

// ---------------------------------------------------------------------------
// Process phases (coarse roll-up of the TLT sequence)
// ---------------------------------------------------------------------------
// Four shop-floor phases that group activities into the stages the workshop
// reports against. The TLT bands are SLICED from PROCESS_SEQUENCE (single source,
// so they can never drift from the canonical ordering). Display/roll-up only —
// never changes parsing, Activity values, qty, ageing, or dedup.
//   Cutting            = first step (C)
//   Quality Check      = everything between cutting and galvanising (RFI..Q, TS)
//   Galvanising        = G..Y (through the terminal Yard step)
//   Ready for Dispatch = Finished Goods (FG) field, not an activity code
// TS (Tee Stock) is the last fabrication step and belongs to Quality Check, so
// the galvanising phase starts at G.
export type ProcessPhaseKey = "cutting" | "quality" | "galvanising" | "dispatch";

const GALV_START_INDEX = PROCESS_SEQUENCE.indexOf("G");
const DISPATCH_INDEX = PROCESS_SEQUENCE.length - 1;

// NTLT-only pre-galvanising fabrication codes (e.g. NTF/NTFSW/NTFW): they appear
// in an NTLT sequence ahead of "TS" but are absent from the TLT sequence. Roll
// them into Quality Check so NTLT/ALL views don't drop marks from the phases.
const NTLT_FAB_CODES = Array.from(
  new Set(
    Object.values(SEQUENCES).flatMap((seq) => {
      const tsIdx = seq.indexOf("TS");
      const head = (tsIdx === -1 ? seq : seq.slice(0, tsIdx)) as readonly string[];
      return head.filter((c) => !(PROCESS_SEQUENCE as readonly string[]).includes(c));
    }),
  ),
);

export type ProcessPhase = {
  key: ProcessPhaseKey;
  label: string;
  activities: readonly string[];
  // Optional override for the small "(...)" sub-label rendered under the phase
  // heading. When set, the UI shows this verbatim instead of the joined activity
  // codes. Used by Ready for Dispatch, which reports the Finished Goods (FG)
  // record field rather than an activity code.
  subLabel?: string;
};

export const PROCESS_PHASES: ProcessPhase[] = [
  { key: "cutting", label: "Cutting", activities: [PROCESS_SEQUENCE[0]] },
  {
    key: "quality",
    label: "Quality Check",
    activities: [...PROCESS_SEQUENCE.slice(1, GALV_START_INDEX), ...NTLT_FAB_CODES],
  },
  {
    key: "galvanising",
    label: "Galvanising",
    // G, GB, Y — the Galvanising phase now spans through the terminal Yard step.
    activities: PROCESS_SEQUENCE.slice(GALV_START_INDEX),
  },
  {
    key: "dispatch",
    label: "Ready for Dispatch",
    // Reports Finished Good WIP Computed (live WIP Galvanizing minus file
    // Dispatch, from Order Status), not an activity code: Y now rolls into
    // Galvanising, so no activity routes here. The Project-Wise page fills
    // this column per-project from `useFgRows()`, not from any WIP record field.
    activities: [],
    subLabel: "FG",
  },
];

const PHASE_BY_CODE = new Map<string, ProcessPhaseKey>();
for (const phase of PROCESS_PHASES) {
  for (const code of phase.activities) PHASE_BY_CODE.set(code.toUpperCase(), phase.key);
}

// Order Type mode for the Project-Wise phase display. "ALL" shows every phase's
// full activity list (TLT + NTLT); "TLT"/"NTLT" narrow each phase's listed codes
// to just that category's sequences. Display/roll-up only — the phase KEYS and
// the code->phase mapping (processPhase) are unchanged, so counting is identical.
export type OrderTypeMode = "ALL" | MarkCategory;

// Return PROCESS_PHASES with each phase's `activities` scoped to the given mode.
// Codes are drawn IN SEQUENCE ORDER from the mode's own sequences (TLT = the TLT
// route; NTLT = the union of the NTLT sequences, deduped first-seen), so e.g. the
// NTLT Quality Check reads "NTF, NTFSW, NTFW, TS" rather than the combined list.
export function processPhasesForMode(mode: OrderTypeMode): ProcessPhase[] {
  if (mode === "ALL") return PROCESS_PHASES;
  const seqs: readonly (readonly string[])[] =
    mode === "TLT"
      ? [SEQUENCES.TLT]
      : Object.entries(SEQUENCES)
          .filter(([k]) => k !== "TLT")
          .map(([, seq]) => seq);
  const perPhase = new Map<ProcessPhaseKey, string[]>(
    PROCESS_PHASES.map((p) => [p.key, [] as string[]]),
  );
  const seen = new Set<string>();
  for (const seq of seqs) {
    for (const code of seq) {
      const up = code.toUpperCase();
      if (seen.has(up)) continue;
      const key = PHASE_BY_CODE.get(up);
      if (!key) continue;
      seen.add(up);
      perPhase.get(key)!.push(code);
    }
  }
  return PROCESS_PHASES.map((phase) => ({
    key: phase.key,
    label: phase.label,
    activities: perPhase.get(phase.key)!,
    subLabel: phase.subLabel,
  }));
}

// ---------------------------------------------------------------------------
// Activity bundles (filter shortcuts)
// ---------------------------------------------------------------------------
// Named groupings of activity codes used purely as filter SHORTCUTS in the
// activity dropdown. Selecting a bundle is equivalent to OR-ing its member
// activities. Display/filter only — it NEVER changes parsing, Activity values,
// qty, ageing, dedup, the process phases above, or the Project-Wise stage
// buckets (which are independent and intentionally kept distinct).
//
// Member codes are SLICED from PROCESS_SEQUENCE (single source of truth) so they
// can never drift from canonical ordering. TLT bundles are namespaced (id AND
// label both carry "TLT") so NTLT counterparts can be added later without
// collision. `scope` controls which Order Type modes a bundle is offered in:
//   "TLT" — offered in TLT and All modes only
//   "ALL" — offered in every mode (TLT, NTLT, All)
export type BundleScope = "TLT" | "ALL";
export interface ActivityBundle {
  id: string;
  label: string;
  scope: BundleScope;
  activities: readonly string[];
  // Hidden bundles are resolvable (getActivityBundle / bundleActivitySet still
  // return them) but are NOT offered in the activity dropdown. Used for internal
  // drill-down targets that must not appear as a user-selectable shortcut.
  hidden?: boolean;
}

// Bundle boundary between fabrication and galvanising. TS (Tee Stock) is the last
// fabrication step, so it belongs to the FABRICATION bundles (and to the Quality
// Check phase) and the Galvanizing bundle starts at G. This matches
// GALV_START_INDEX (= indexOf("G")), which drives the Project-Wise PROCESS_PHASES
// stage buckets — both keep TS out of Galvanising.
const BUNDLE_GALV_START_INDEX = PROCESS_SEQUENCE.indexOf("G");

export const ACTIVITY_BUNDLES: readonly ActivityBundle[] = [
  {
    id: "TLT_FABRICATION",
    label: "Fabrication (TLT)",
    scope: "TLT",
    // C -> TS (everything up to and including TS, before galvanising).
    activities: PROCESS_SEQUENCE.slice(0, BUNDLE_GALV_START_INDEX),
  },
  {
    id: "TLT_FAB_PENDING_QUALITY",
    label: "Fab - Pending Quality (TLT)",
    scope: "TLT",
    // RFI -> TS (fabrication minus the cutting-prep steps C and HG). Sliced from
    // RFI explicitly (not index 1) so HG — which now sits before RFI — is
    // correctly EXCLUDED from Fab-Pending.
    activities: PROCESS_SEQUENCE.slice(
      PROCESS_SEQUENCE.indexOf("RFI"),
      BUNDLE_GALV_START_INDEX,
    ),
  },
  {
    id: "GALVANIZING",
    label: "Galvanizing",
    scope: "ALL",
    // G, GB, Y — the Galvanizing stage-group/filter now spans through the
    // terminal Yard step (TS still excluded — it lives in the fabrication
    // bundles). Y also remains available on its own via the YARD bundle. Roll-up
    // tables that keep a SEPARATE Yard column (Order Status, Contractor) must
    // exclude the Yard codes from this set to avoid double-counting Y.
    activities: PROCESS_SEQUENCE.slice(BUNDLE_GALV_START_INDEX),
  },
  {
    // Hidden drill-down target: the Galvanizing stage EXCLUDING the terminal Yard
    // step (G, GB). Used by roll-up tables that show a separate Yard column
    // (e.g. Contractor's "Galvanizing Load" cell) so the drill matches the cell's
    // G,GB-only metric instead of the wider G,GB,Y GALVANIZING bundle. Not shown
    // in the activity dropdown.
    id: "GALVANIZING_CORE",
    label: "Galvanizing (G, GB)",
    scope: "ALL",
    activities: PROCESS_SEQUENCE.slice(BUNDLE_GALV_START_INDEX, DISPATCH_INDEX),
    hidden: true,
  },
  {
    id: "YARD",
    label: "Yard",
    scope: "ALL",
    // Y (terminal).
    activities: [PROCESS_SEQUENCE[DISPATCH_INDEX]],
  },
  // Operation sub-bundles (TLT-only). These overlap the broad Fabrication /
  // Fab-Pending bundles by design — a mark can match more than one bundle;
  // bundles are filter shortcuts, not exclusive partitions.
  {
    id: "TLT_STANDARD_OPERATIONS",
    label: "Standard Operations (TLT)",
    scope: "TLT",
    // C, HG (grinding on the cut piece), then RFI, NH — the early cutting-prep
    // and inspection steps, before the special (B/HAB/W) operations.
    activities: ["C", "HG", "RFI", "NH"],
  },
  {
    id: "TLT_SPECIAL_OPERATIONS",
    label: "Special Operations (TLT)",
    scope: "TLT",
    activities: ["B", "HAB", "W"],
  },
  {
    id: "TLT_QUALITY",
    label: "Quality (TLT)",
    scope: "TLT",
    activities: ["Q", "TS"],
  },
];

const BUNDLE_BY_ID = new Map(ACTIVITY_BUNDLES.map((b) => [b.id, b]));

// Look up a bundle definition by id.
export function getActivityBundle(id: string): ActivityBundle | undefined {
  return BUNDLE_BY_ID.get(id);
}

// Resolve a bundle id to the uppercased set of its member activity codes (for
// case-insensitive matching), or null if the id is unknown.
export function bundleActivitySet(id: string): Set<string> | null {
  const b = BUNDLE_BY_ID.get(id);
  if (!b) return null;
  return new Set(b.activities.map((a) => a.toUpperCase()));
}

// The three TLT operation sub-bundles, in display order. The page-level
// "operation tabs" (Activity Wise, Plant Operation Fabrication) render an "All"
// tab plus these three. TLT-only; display/filter only.
export const TLT_OPERATION_BUNDLE_IDS = [
  "TLT_STANDARD_OPERATIONS",
  "TLT_SPECIAL_OPERATIONS",
  "TLT_QUALITY",
] as const;

// ---------------------------------------------------------------------------
// Contractor sub-categories (config overlay, additive)
// ---------------------------------------------------------------------------
// A purely descriptive classification of each contractor into CNC /
// Sub-contractor / Out-vendor, with Out-vendors additionally tagged FAB and/or
// GALVA. It is stored in its own config table keyed by a NORMALIZED contractor
// name and joined to records at read time — it NEVER changes parsing, Activity
// values, qty, ageing, dedup, the row hash, or the contractor string itself.
// Unmapped contractors are treated as "Unclassified".
export type ContractorCategory =
  | "CNC"
  | "SUB_CONTRACTOR"
  | "OUT_VENDOR"
  | "UNCLASSIFIED";

export type OutVendorType = "FAB" | "GALVA";

export const CONTRACTOR_CATEGORIES: {
  value: ContractorCategory;
  label: string;
}[] = [
  { value: "CNC", label: "CNC" },
  { value: "SUB_CONTRACTOR", label: "Sub-contractor" },
  { value: "OUT_VENDOR", label: "Out-vendor" },
  { value: "UNCLASSIFIED", label: "Unclassified" },
];

export const OUT_VENDOR_TYPES: { value: OutVendorType; label: string }[] = [
  { value: "FAB", label: "Fabrication" },
  { value: "GALVA", label: "Galvanizing" },
];

const CONTRACTOR_CATEGORY_LABELS = new Map<ContractorCategory, string>(
  CONTRACTOR_CATEGORIES.map((c) => [c.value, c.label]),
);
const OUT_VENDOR_TYPE_LABELS = new Map<OutVendorType, string>(
  OUT_VENDOR_TYPES.map((t) => [t.value, t.label]),
);

export function contractorCategoryLabel(
  value: string | null | undefined,
): string {
  return CONTRACTOR_CATEGORY_LABELS.get(value as ContractorCategory) ?? "Unclassified";
}

export function outVendorTypeLabel(value: string | null | undefined): string {
  return OUT_VENDOR_TYPE_LABELS.get(value as OutVendorType) ?? String(value ?? "");
}

export function isContractorCategory(v: unknown): v is ContractorCategory {
  return (
    v === "CNC" ||
    v === "SUB_CONTRACTOR" ||
    v === "OUT_VENDOR" ||
    v === "UNCLASSIFIED"
  );
}

// Virtual "In-House" contractor grouping. This is a FILTER-ONLY shortcut value
// (never stored, NOT a ContractorCategory): selecting it matches every contractor
// whose stored category is CNC OR SUB_CONTRACTOR. Storage/classification is
// unchanged — In-House is computed at read/filter time only.
export const IN_HOUSE_GROUP = "IN_HOUSE";
export const IN_HOUSE_MEMBERS: ContractorCategory[] = ["CNC", "SUB_CONTRACTOR"];

// Single source of truth for matching a contractor's stored category against a
// selected contractor-category filter value, honouring the virtual In-House
// group. Used by the shared record filter so client and server stay identical.
export function matchesContractorCategoryFilter(
  category: string,
  filter: string,
): boolean {
  if (filter === IN_HOUSE_GROUP) {
    return category === "CNC" || category === "SUB_CONTRACTOR";
  }
  return category === filter;
}

export function isOutVendorType(v: unknown): v is OutVendorType {
  return v === "FAB" || v === "GALVA";
}

// --- Plant Location (per-contractor metadata, display-only) -------------------
// Purely descriptive; NEVER affects classification, buckets, or ageing.
export type PlantLocation = "unit_1" | "unit_2";

export const PLANT_LOCATION_OPTIONS: { value: PlantLocation | null; label: string }[] = [
  { value: null, label: "Unassigned" },
  { value: "unit_1", label: "VTPL Unit-1" },
  { value: "unit_2", label: "VTPL Unit-2" },
];

export function isPlantLocation(v: unknown): v is PlantLocation {
  return v === "unit_1" || v === "unit_2";
}

export function plantLocationLabel(v: string | null | undefined): string {
  return PLANT_LOCATION_OPTIONS.find((o) => o.value === v)?.label ?? "Unassigned";
}

// --- "Fabrication Load for TLT" report (display/planning overlay only) ---------
// Two sections (work AT an operation = operational; work BEFORE it = inhand),
// five load columns each, and a per-row Priority (P1..P10). These constants are
// the single source of truth shared by the API validators and the frontend.
export type FabLoadSection = "operational" | "inhand";
export type FabLoadColumn =
  | "welded"
  | "bending"
  | "drilling"
  | "platePunch"
  | "plateDrill";

export const FAB_LOAD_SECTIONS: { value: FabLoadSection; label: string }[] = [
  { value: "operational", label: "Operation Load" },
  { value: "inhand", label: "In Hand" },
];

// Column order matches the operation sheet: Welded, Drilling, Plate Punch,
// Plate Drill, Bending.
export const FAB_LOAD_COLUMNS: { value: FabLoadColumn; label: string }[] = [
  { value: "welded", label: "Welded Load" },
  { value: "drilling", label: "Drilling Load" },
  { value: "platePunch", label: "Plate Punch" },
  { value: "plateDrill", label: "Plate Drill" },
  { value: "bending", label: "Bending Load" },
];

// Both sections (Operational and In Hand) carry the same five columns —
// Welded, Drilling, Plate Punch, Plate Drill, Bending — in the same order.
// In-Hand Bending = marks positioned before B in the TLT sequence (C, HG, RFI, NH).
export function fabLoadColumnsForSection(
  _section: FabLoadSection,
): { value: FabLoadColumn; label: string }[] {
  return FAB_LOAD_COLUMNS;
}

// P1..P10 (extendable later by widening this range).
export const FAB_PRIORITIES: string[] = Array.from(
  { length: 10 },
  (_, i) => `P${i + 1}`,
);

export function isFabLoadSection(v: unknown): v is FabLoadSection {
  return v === "operational" || v === "inhand";
}

export function isFabLoadColumn(v: unknown): v is FabLoadColumn {
  return (
    v === "welded" ||
    v === "bending" ||
    v === "drilling" ||
    v === "platePunch" ||
    v === "plateDrill"
  );
}

export function isFabPriority(v: unknown): v is string {
  return typeof v === "string" && FAB_PRIORITIES.includes(v);
}

// Normalize a contractor name into the join KEY: uppercase, collapse internal
// whitespace runs to a single space, and trim. This only smooths over casing and
// spacing inconsistencies (e.g. accidental double spaces) — it deliberately
// preserves every alphanumeric token and suffix (GP-2, UNIT-II, (JW), -C), so
// two contractors that differ by such a tag NEVER collapse onto the same key.
export function normalizeContractorName(
  name: string | null | undefined,
): string {
  return (name ?? "").trim().replace(/\s+/g, " ").toUpperCase();
}

export interface ContractorCategorySeed {
  name: string;
  category: ContractorCategory;
  outVendorType: OutVendorType[];
}

// Seed list of known out-vendors with their FAB/GALVA tags (full names exactly
// as they appear in the source workbook). Applied once at boot with
// onConflictDoNothing on the normalized key, so user edits always win and
// re-seeding is idempotent. CNC / Sub-contractor are intentionally NOT
// seeded — they start Unclassified and are set in-app.
export const CONTRACTOR_CATEGORY_SEED: ContractorCategorySeed[] = [
  { name: "BAJRANG STEEL INDUSTRIES & MINERALS PVT.LTD.JW", category: "OUT_VENDOR", outVendorType: ["FAB"] },
  { name: "DASHMESH ENGINEERING WORKS  (JW)", category: "OUT_VENDOR", outVendorType: ["FAB"] },
  { name: "MAHIMA MERCHANDIZING P.V.T LTD. -JW", category: "OUT_VENDOR", outVendorType: ["FAB"] },
  { name: "MARUTINANDAN STRUCTURES PVT LTD.", category: "OUT_VENDOR", outVendorType: ["FAB"] },
  { name: "RR ISPAT LIMITED", category: "OUT_VENDOR", outVendorType: ["FAB", "GALVA"] },
  { name: "RUKMANI ELECTRICAL & COMPONENTS PVT LTD - C", category: "OUT_VENDOR", outVendorType: ["FAB"] },
  { name: "SANGAM ISPAT (INDIA) PVT LIMITED", category: "OUT_VENDOR", outVendorType: ["FAB"] },
  { name: "SATYA STRUCTURES AND COMPONENTS PRIVATE LTD.", category: "OUT_VENDOR", outVendorType: ["FAB"] },
  { name: "SAVITEK INFRA PRIVATE LIMITED", category: "OUT_VENDOR", outVendorType: ["FAB"] },
  { name: "SDM AGRO ENGINEERING", category: "OUT_VENDOR", outVendorType: ["FAB"] },
  { name: "SHREE SHYAM FABROTECH INDUSTRIES(c)", category: "OUT_VENDOR", outVendorType: ["FAB"] },
  { name: "SHRINANDA ENGINEERING (JW)", category: "OUT_VENDOR", outVendorType: ["FAB"] },
  { name: "SOLAR AQUA SOLUTIONS", category: "OUT_VENDOR", outVendorType: ["FAB"] },
  { name: "SREE SATYA FASTNERS PVT LTD", category: "OUT_VENDOR", outVendorType: ["FAB"] },
  { name: "SURYA STRUCTURE", category: "OUT_VENDOR", outVendorType: ["FAB"] },
  { name: "TRANSRAIL STRUCTURES AND TOWRS", category: "OUT_VENDOR", outVendorType: ["FAB"] },
  { name: "DHARAM INDUSTRIES", category: "OUT_VENDOR", outVendorType: ["GALVA"] },
  { name: "HELLO STEEL PVT LTD (JW)", category: "OUT_VENDOR", outVendorType: ["GALVA"] },
  { name: "KHYATI ISPAT PRIVATE LIMITED  - JW", category: "OUT_VENDOR", outVendorType: ["GALVA"] },
  { name: "NANDAN STEELS AND POWER LTD", category: "OUT_VENDOR", outVendorType: ["GALVA"] },
  { name: "PAVAN SAI WORKS - JW", category: "OUT_VENDOR", outVendorType: ["GALVA"] },
  { name: "PHOENIX STRUCTURAL & ENGINEERING PVT.LTD.", category: "OUT_VENDOR", outVendorType: ["GALVA"] },
  { name: "PHOENIX STRUCTURAL & ENGINEERING PVT.LTD. (NGP)", category: "OUT_VENDOR", outVendorType: ["GALVA"] },
  { name: "POWER LINE ACCESSORIES - JW", category: "OUT_VENDOR", outVendorType: ["GALVA"] },
  { name: "PREMIER ROLLING & FORGING WORKS", category: "OUT_VENDOR", outVendorType: ["GALVA"] },
  { name: "SHRI ASHUTOSH ENGINEERING INDUSTRIES UNIT II", category: "OUT_VENDOR", outVendorType: ["GALVA"] },
  { name: "SRISINGHANIYA STRUCTURES PRIVATE LIMITED", category: "OUT_VENDOR", outVendorType: ["GALVA"] },
];

// Map an activity code to its coarse process phase (case-insensitive). Known TLT
// and NTLT codes resolve to a phase; only genuinely unknown codes return null, so
// callers can surface those separately rather than miscount.
export function processPhase(code: string | null | undefined): ProcessPhaseKey | null {
  const c = (code ?? "").trim().toUpperCase();
  if (!c) return null;
  return PHASE_BY_CODE.get(c) ?? null;
}

// Normalize an activity code for matching only (trim + uppercase). Used for
// case-insensitive comparison so "Hab"/"HAB" rank the same. The original value
// is always preserved for display.
export function normalizeActivity(code: string | null | undefined): string {
  return (code ?? "").trim().toUpperCase();
}

const RANK_BY_CODE = new Map<string, number>(
  PROCESS_SEQUENCE.map((code, index) => [code, index]),
);

// Index of a code within PROCESS_SEQUENCE (case-insensitive). Unknown codes
// return a rank greater than every known step, so they always sort to the end.
export function activityRank(code: string | null | undefined): number {
  const rank = RANK_BY_CODE.get(normalizeActivity(code));
  return rank === undefined ? PROCESS_SEQUENCE.length : rank;
}

// Whether a code is one of the canonical process steps (case-insensitive).
export function isKnownActivity(code: string | null | undefined): boolean {
  return RANK_BY_CODE.has(normalizeActivity(code));
}

// Index of a code within an ARBITRARY sequence (case-insensitive). Unknown codes
// return a rank greater than every step in that sequence, so they sort to the
// end. This is the sequence-aware generalisation of activityRank.
export function rankIn(
  sequence: ActivitySequence,
  code: string | null | undefined,
): number {
  const idx = sequence.indexOf(normalizeActivity(code));
  return idx === -1 ? sequence.length : idx;
}

// Whether a code belongs to a given sequence (case-insensitive).
export function isKnownIn(
  sequence: ActivitySequence,
  code: string | null | undefined,
): boolean {
  return sequence.indexOf(normalizeActivity(code)) !== -1;
}

// Union of every standard activity code across all known sequences (TLT + NTLT).
// Used ONLY as a membership set when parsing a mark's Col Q "Operation" route.
const STANDARD_ACTIVITY_CODES = new Set<string>(
  Object.values(SEQUENCES).flat().map((c) => normalizeActivity(c)),
);

// Parse a mark's Col Q "Operation" string (its FULL route, e.g.
// "C,P,S,RFI,Q,G,GB") into the SET of STANDARD activity codes it contains.
// Comma-separated tokens are trimmed/uppercased and INTERSECTED with the standard
// activity set, so non-standard route codes (P, S, D, N, BL, ...) are dropped —
// Col Q is used only as a membership lookup for the standard operations.
// Derived/display-only: never hashed, never affects parsing/ageing/dedup/qty/
// activity. Blank/absent Col Q (or a route with no standard codes) yields an
// empty set, which callers treat as "route unknown" and fall back rather than
// excluding the mark.
export function routeOps(operation: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (operation == null) return out;
  for (const raw of operation.split(",")) {
    const code = normalizeActivity(raw);
    if (code && STANDARD_ACTIVITY_CODES.has(code)) out.add(code);
  }
  return out;
}

// Whether a mark's Col Q route includes a given standard operation. Only a
// genuinely BLANK Col Q (null / empty / whitespace) falls back to `true` so the
// caller keeps its prior positional behaviour rather than silently zeroing the
// mark's upcoming ("In Hand") load. A NON-blank route that simply does not list
// the op (even if it contains only non-standard tokens) returns false — that
// mark legitimately never performs the op. `op` is a standard activity code
// (e.g. "W", "B").
export function routeIncludesOp(
  operation: string | null | undefined,
  op: string,
): boolean {
  if (operation == null || operation.trim() === "") return true; // blank -> don't exclude
  return routeOps(operation).has(normalizeActivity(op));
}

// Map a category (+ NTLT subtype) to its SequenceKey. Anything that is not
// explicitly NTLT is treated as TLT (the safe default that preserves existing
// behaviour). NTLT with an unrecognised/blank subtype falls back to the General
// 4-step route rather than the 12-step TLT route.
export function sequenceKeyFor(
  category: string | null | undefined,
  ntltSubtype?: string | null | undefined,
): SequenceKey {
  if (normalizeActivity(category) !== "NTLT") return "TLT";
  switch (normalizeActivity(ntltSubtype)) {
    case "RSJ":
      return "NTLT_RSJ";
    case "EARTHING":
      return "NTLT_EARTHING";
    case "GENERAL":
      return "NTLT_GENERAL";
    default:
      return "NTLT_GENERAL";
  }
}

// The process sequence for a category (+ NTLT subtype).
export function sequenceForCategory(
  category: string | null | undefined,
  ntltSubtype?: string | null | undefined,
): ActivitySequence {
  return SEQUENCES[sequenceKeyFor(category, ntltSubtype)];
}

// The process sequence for a record (reads its category/ntltSubtype fields).
export function sequenceFor(record: CategorizedRecord): ActivitySequence {
  return sequenceForCategory(record.category, record.ntltSubtype);
}

// The warning-settings category for a record's category/subtype. NTLT rows map
// to NTLT_<subtype> (defaulting GENERAL); everything else is TLT.
export function settingsCategoryFor(
  category: string | null | undefined,
  ntltSubtype?: string | null | undefined,
): SettingsCategory {
  const key = sequenceKeyFor(category, ntltSubtype);
  return key as SettingsCategory;
}

// The resolution scope for a record: which category's parameters to read and the
// override key (project for TLT, section/group_key for NTLT). Used so a mark's
// alert/lifecycle/velocity reads ITS category's settings and the right override.
export function scopeFor(
  record: CategorizedRecord & {
    job?: string | null;
    groupKey?: string | null;
  },
): ScopeRef {
  const category = settingsCategoryFor(record.category, record.ntltSubtype);
  if (category === "TLT") {
    return { category: "TLT", key: record.job ?? null };
  }
  const ntltSubtype = (record.ntltSubtype ?? "GENERAL")
    .toString()
    .toUpperCase() as NtltSubtype;
  return { category, ntltSubtype, key: record.groupKey ?? null };
}

// The final stage of a sequence (always "Y"/Yard for the canonical sequences).
export function finalStage(sequence: ActivitySequence): string {
  return sequence[sequence.length - 1] ?? "Y";
}

// Stage index of a record's current activity WITHIN ITS OWN sequence.
export function stageIndex(
  record: CategorizedRecord & { activity?: string | null },
): number {
  return rankIn(sequenceFor(record), record.activity);
}

// Comparator: known codes by sequence rank; unknown codes after, ordered
// alphabetically among themselves. Never drops anything. Defaults to the TLT
// sequence so existing callers are unchanged; pass a sequence to order NTLT rows.
export function compareActivity(
  a: string | null | undefined,
  b: string | null | undefined,
  sequence: ActivitySequence = PROCESS_SEQUENCE,
): number {
  const rankDelta = rankIn(sequence, a) - rankIn(sequence, b);
  if (rankDelta !== 0) return rankDelta;
  // Equal rank => both unknown (or the same code); break ties alphabetically.
  return normalizeActivity(a).localeCompare(normalizeActivity(b));
}

// Sort a list of activity codes by the canonical order. Returns a new array.
// Defaults to the TLT sequence; pass a sequence to order an NTLT category's codes.
export function sortActivities<T extends string | null | undefined>(
  codes: T[],
  sequence: ActivitySequence = PROCESS_SEQUENCE,
): T[] {
  return [...codes].sort((a, b) => compareActivity(a, b, sequence));
}

// ---------------------------------------------------------------------------
// Turnaround-time warning engine
// ---------------------------------------------------------------------------
// Deterministic, advisory-only. Compares a mark's LIVE ageing (already computed
// server-side as today - last_production_date) against a CUMULATIVE target that
// accumulates the per-activity ideal days down PROCESS_SEQUENCE. It NEVER
// changes parsing, Activity values, quantities, ageing, or dedup — it is a
// display/classification layer that can be recomputed live as settings change,
// without re-importing.

// Per-activity turnaround configuration. `idealDays` feeds the cumulative
// target. Each grace band (yellow/orange/red) is a CELL that is either MANUAL
// (a pinned day value) or AUTO (derived as a percentage of THIS activity's own
// ideal days). The resolved/effective grace days are computed at read time
// (resolveActivityGrace); ordering (yellow <= orange <= red) is enforced on the
// resolved row, never on the stored cells (an auto cell depends on idealDays).
export type GraceMode = "auto" | "manual";

// One grace band cell. `mode` decides which field is effective; both are kept so
// toggling auto<->manual remembers the last percentage/value.
export interface GraceCell {
  mode: GraceMode;
  // AUTO: percent of this activity's ideal days. effective = round(percent/100 * idealDays).
  percent?: number;
  // MANUAL: pinned grace days (overrun beyond the cumulative target).
  value?: number;
}

// Three escalating PRE-WARNING thresholds, each a PERCENT of the activity's
// cumulative target consumed (consumed = ageing / cumulativeTarget). They apply
// only while the mark is still WITHIN target (overrun <= 0); once the target is
// exceeded the existing breach bands (grace cells) take over. Invariant after
// resolution: 0 <= pw1 <= pw2 <= pw3 <= 100.
export interface PreWarnConfig {
  pw1: number;
  pw2: number;
  pw3: number;
}

// Full per-activity config: ideal days, the three grace-band cells (breach
// phase), and the three pre-warning percentage thresholds (within-target phase).
export interface ActivityConfig {
  idealDays: number;
  yellow: GraceCell;
  orange: GraceCell;
  red: GraceCell;
  preWarn: PreWarnConfig;
}

// A sparse per-project override. Any field present REPLACES the global value for
// that (project, activity); any field absent INHERITS the global cell/ideal.
// Whole rows/projects may be omitted entirely. Inheritance is PER CELL. The
// pre-warning override is itself sparse (any subset of pw1/pw2/pw3).
export interface PartialActivityConfig {
  idealDays?: number;
  yellow?: GraceCell;
  orange?: GraceCell;
  red?: GraceCell;
  preWarn?: Partial<PreWarnConfig>;
}

// The RESOLVED, effective numeric grace for one (project, activity): plain day
// values consumed by the cumulative-target + status math. This is the shape the
// rest of the engine and the consumers work with; the stored cells above are an
// editor/persistence detail resolved into this by resolveActivityGrace.
export interface ActivityGrace {
  idealDays: number;
  yellowGrace: number;
  orangeGrace: number;
  redGrace: number;
}

// One NTLT category's warning configuration. The NTLT analogue of the top-level
// TLT (`activities`/`perProject`) pair: a global ("All Sections") per-activity
// config plus sparse per-SECTION overrides (keyed by group_key/section). Same
// per-cell inheritance + auto/manual model as TLT, only scoped by section.
export interface CategorySettings {
  // GLOBAL ("All Sections") per-activity config keyed by the activity codes of
  // THIS category's sequence (e.g. NTF..Y for RSJ; TS..Y for Earthing/General).
  activities: Record<string, ActivityConfig>;
  // Sparse per-section overrides: section -> activity code -> partial config.
  perSection?: Record<string, Record<string, PartialActivityConfig>>;
}

// The four configurable warning categories. TLT is the original 12-step route;
// the three NTLT categories follow their shorter sequences (see SEQUENCES).
export type SettingsCategory =
  | "TLT"
  | "NTLT_RSJ"
  | "NTLT_EARTHING"
  | "NTLT_GENERAL";

export interface TurnaroundSettings {
  // GLOBAL ("All Projects") per-activity config keyed by canonical activity code
  // (PROCESS_SEQUENCE). This is the TLT category. Applies to any TLT project
  // without its own override.
  activities: Record<string, ActivityConfig>;
  // Sparse per-project overrides (TLT): project -> activity code -> partial config.
  // Only overridden cells/fields are stored; everything else inherits `activities`.
  perProject?: Record<string, Record<string, PartialActivityConfig>>;
  // Stalled-mark threshold (days). A mark whose activity/last-production signature
  // has not changed for >= this many days is flagged stalled. App-level (not
  // per-activity). Defaults to DEFAULT_STALLED_DAYS when unset.
  stalledDays?: number;
  // The three NTLT categories' configs (each global + per-section). Seeded with
  // defaults by migrateTurnaroundSettings so the engine always has values. TLT
  // stays at the top level above (byte-for-byte back-compat).
  ntlt?: Partial<Record<NtltSubtype, CategorySettings>>;
  // Global "valid data starts here" cutoff (YYYY-MM-DD) or null (default). When
  // set, the whole app considers only WIP imports dated on/after this day; older
  // imports are ignored. null = no cutoff = byte-identical to prior behaviour.
  // Scoping only: never affects any per-activity/warning/ageing computation here.
  validFromDate?: string | null;
}

// A resolution scope for the warning engine: which category's parameters to read
// and which override key (project for TLT, section for NTLT) to apply. Passing a
// bare string (or null/undefined) means the TLT category with that project key,
// so every existing TLT call site is unchanged.
export interface ScopeRef {
  category?: SettingsCategory | null;
  // For NTLT, the subtype (RSJ/EARTHING/GENERAL). Ignored for TLT.
  ntltSubtype?: NtltSubtype | null;
  // Override key: project (TLT) or section/group_key (NTLT). Omit for the global
  // ("All Projects"/"All Sections") default.
  key?: string | null;
}

// Either a legacy TLT project string (or null/undefined for global) or a full
// ScopeRef. Lets every existing `project`-string caller stay unchanged.
export type ScopeArg = string | null | undefined | ScopeRef;

// green: at/under target. yellow/orange/red: increasing overrun. na: no defined
// target (activity outside PROCESS_SEQUENCE) or no ageing (blank production
// date) — never a false green/red.
export type AlertStatus = "green" | "yellow" | "orange" | "red" | "na";

export interface AlertResult {
  status: AlertStatus;
  target: number | null;
  overrun: number | null;
}

const DEFAULT_IDEAL_DAY = 3;
const DEFAULT_YELLOW_GRACE = 7;
const DEFAULT_ORANGE_GRACE = 21;
const DEFAULT_RED_GRACE = 21;

// Default pre-warning thresholds (percent of cumulative target consumed) and the
// default stalled threshold (days).
export const DEFAULT_PRE_WARN: PreWarnConfig = { pw1: 70, pw2: 85, pw3: 95 };
export const DEFAULT_STALLED_DAYS = 10;

// Defaults preserve the prior behaviour: MANUAL grace cells at 7/21/21 days
// (percentages start unset / auto-off until the user opts a cell into a %).
export const DEFAULT_ACTIVITY_CONFIG: ActivityConfig = {
  idealDays: DEFAULT_IDEAL_DAY,
  yellow: { mode: "manual", value: DEFAULT_YELLOW_GRACE },
  orange: { mode: "manual", value: DEFAULT_ORANGE_GRACE },
  red: { mode: "manual", value: DEFAULT_RED_GRACE },
  preWarn: { ...DEFAULT_PRE_WARN },
};

export const DEFAULT_TURNAROUND_SETTINGS: TurnaroundSettings = {
  activities: Object.fromEntries(
    PROCESS_SEQUENCE.map((step) => [step, cloneConfig(DEFAULT_ACTIVITY_CONFIG)]),
  ),
};

function safeDays(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}

function pInt(v: unknown, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
  return Math.max(0, Math.round(n));
}

function optInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0
    ? Math.max(0, Math.round(v))
    : undefined;
}

function cloneCell(c: GraceCell): GraceCell {
  return { ...c };
}

function cloneConfig(c: ActivityConfig): ActivityConfig {
  return {
    idealDays: c.idealDays,
    yellow: cloneCell(c.yellow),
    orange: cloneCell(c.orange),
    red: cloneCell(c.red),
    preWarn: { ...c.preWarn },
  };
}

// Clamp a single pre-warning threshold to an integer percent in [0, 100].
function clampPct(v: unknown, fallback: number): number {
  const n =
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : fallback;
  return Math.min(100, Math.max(0, n));
}

// Optional integer percent in [0,100] (undefined when absent/invalid).
function optPct(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0
    ? Math.min(100, Math.max(0, Math.round(v)))
    : undefined;
}

// Order a resolved pre-warning row so pw1 <= pw2 <= pw3 (raise later bands).
function orderPreWarn(p: PreWarnConfig): PreWarnConfig {
  const pw1 = clampPct(p.pw1, DEFAULT_PRE_WARN.pw1);
  const pw2 = Math.max(pw1, clampPct(p.pw2, DEFAULT_PRE_WARN.pw2));
  const pw3 = Math.max(pw2, clampPct(p.pw3, DEFAULT_PRE_WARN.pw3));
  return { pw1, pw2, pw3 };
}

// Migrate a stored full pre-warning row (defaults seeded + clamped + ordered).
function migratePreWarn(raw: unknown): PreWarnConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return orderPreWarn({
    pw1: clampPct(o.pw1, DEFAULT_PRE_WARN.pw1),
    pw2: clampPct(o.pw2, DEFAULT_PRE_WARN.pw2),
    pw3: clampPct(o.pw3, DEFAULT_PRE_WARN.pw3),
  });
}

// Migrate a SPARSE per-project pre-warning override (keep only present fields).
function normalizePartialPreWarn(raw: unknown): Partial<PreWarnConfig> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const out: Partial<PreWarnConfig> = {};
  const pw1 = optPct(o.pw1);
  const pw2 = optPct(o.pw2);
  const pw3 = optPct(o.pw3);
  if (pw1 !== undefined) out.pw1 = pw1;
  if (pw2 !== undefined) out.pw2 = pw2;
  if (pw3 !== undefined) out.pw3 = pw3;
  return Object.keys(out).length > 0 ? out : undefined;
}

// Resolve ONE grace band cell to effective overrun-days for a given ideal-days.
// MANUAL -> the pinned value; AUTO -> round(percent/100 * idealDays). Missing
// percent/value are treated as 0 (never NaN).
export function resolveCell(
  cell: GraceCell | undefined,
  idealDays: number,
): number {
  if (!cell) return 0;
  if (cell.mode === "auto") {
    const pct =
      typeof cell.percent === "number" &&
      Number.isFinite(cell.percent) &&
      cell.percent >= 0
        ? cell.percent
        : 0;
    return Math.max(0, Math.round((pct / 100) * Math.max(0, idealDays)));
  }
  return typeof cell.value === "number" &&
    Number.isFinite(cell.value) &&
    cell.value >= 0
    ? Math.round(cell.value)
    : 0;
}

// Clamp a RESOLVED numeric grace row to non-negative integers and enforce the
// ordering invariant yellowGrace <= orangeGrace <= redGrace by raising later
// bands as needed (deterministic auto-correct, so an inverted auto-fill or edit
// can never mislabel).
export function normalizeGrace(g: ActivityGrace): ActivityGrace {
  const idealDays = Math.max(0, Math.round(g.idealDays));
  const yellowGrace = Math.max(0, Math.round(g.yellowGrace));
  const orangeGrace = Math.max(yellowGrace, Math.round(g.orangeGrace));
  const redGrace = Math.max(orangeGrace, Math.round(g.redGrace));
  return { idealDays, yellowGrace, orangeGrace, redGrace };
}

// Sanitize a raw stored cell. Accepts the new {mode,percent,value} shape OR a
// bare number (previous numeric grace -> MANUAL with that value). Keeps both
// percent and value when present so auto<->manual toggles remember each other.
function migrateCell(raw: unknown, fallbackValue: number): GraceCell {
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const percent = optInt(o.percent);
    const value = optInt(o.value);
    if (o.mode === "auto") {
      const cell: GraceCell = { mode: "auto", percent: percent ?? 0 };
      if (value !== undefined) cell.value = value;
      return cell;
    }
    const cell: GraceCell = { mode: "manual", value: value ?? fallbackValue };
    if (percent !== undefined) cell.percent = percent;
    return cell;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return { mode: "manual", value: Math.max(0, Math.round(raw)) };
  }
  return { mode: "manual", value: fallbackValue };
}

// Pick a band cell from a raw per-activity object: prefer the new cell object
// (`yellow`), else the previous numeric field (`yellowGrace`), else fallback.
function cellFor(
  p: Record<string, unknown> | undefined,
  cellKey: string,
  numKey: string,
  fallback: number,
): GraceCell {
  const rawCell = p?.[cellKey];
  if (rawCell && typeof rawCell === "object")
    return migrateCell(rawCell, fallback);
  const n = p?.[numKey];
  if (typeof n === "number" && Number.isFinite(n)) {
    return { mode: "manual", value: Math.max(0, Math.round(n)) };
  }
  return { mode: "manual", value: fallback };
}

// Sanitize a SPARSE per-project override row, keeping ONLY present fields. Each
// band, if present, is a full cell (new shape) or a number (previous shape ->
// MANUAL). Ordering is NOT enforced here (the row is partial + cells are
// mode-dependent); it is enforced after resolution in resolveActivityGrace.
function normalizePartialConfig(raw: unknown): PartialActivityConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const out: PartialActivityConfig = {};
  const ideal = optInt(o.idealDays);
  if (ideal !== undefined) out.idealDays = ideal;
  const bands = [
    ["yellow", "yellowGrace"],
    ["orange", "orangeGrace"],
    ["red", "redGrace"],
  ] as const;
  for (const [cellKey, numKey] of bands) {
    const rawCell = o[cellKey];
    if (rawCell && typeof rawCell === "object") {
      out[cellKey] = migrateCell(rawCell, 0);
    } else if (typeof o[numKey] === "number" && Number.isFinite(o[numKey])) {
      out[cellKey] = {
        mode: "manual",
        value: Math.max(0, Math.round(o[numKey] as number)),
      };
    }
  }
  const preWarn = normalizePartialPreWarn(o.preWarn);
  if (preWarn) out.preWarn = preWarn;
  return out;
}

// Sanitize the sparse per-project override map: keep only known activities, only
// present fields, and drop empty rows/projects so the stored shape stays minimal.
// Sanitize a sparse per-scope (project or section) override map against a given
// sequence: keep only that sequence's activities, only present fields, and drop
// empty rows/scopes so the stored shape stays minimal.
function migratePerScope(
  raw: unknown,
  sequence: ActivitySequence,
): Record<string, Record<string, PartialActivityConfig>> {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, Record<string, PartialActivityConfig>> = {};
  for (const [scopeKey, acts] of Object.entries(obj)) {
    if (!scopeKey || !acts || typeof acts !== "object") continue;
    const cleanedActs: Record<string, PartialActivityConfig> = {};
    for (const step of sequence) {
      const cell = (acts as Record<string, unknown>)[step];
      if (!cell || typeof cell !== "object") continue;
      const cleaned = normalizePartialConfig(cell);
      if (Object.keys(cleaned).length > 0) cleanedActs[step] = cleaned;
    }
    if (Object.keys(cleanedActs).length > 0) out[scopeKey] = cleanedActs;
  }
  return out;
}

function migratePerProject(
  raw: unknown,
): Record<string, Record<string, PartialActivityConfig>> {
  return migratePerScope(raw, PROCESS_SEQUENCE);
}

// Migrate (or seed defaults for) ONE NTLT category's settings against its own
// sequence. Empty/missing raw yields a fully default config for that sequence,
// so the engine always has values for every NTLT category.
function migrateCategorySettings(
  raw: unknown,
  sequence: ActivitySequence,
): CategorySettings {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const provided = obj.activities as Record<string, unknown> | undefined;
  const activities: Record<string, ActivityConfig> = {};
  for (const step of sequence) {
    const rawP = provided?.[step];
    const p =
      rawP && typeof rawP === "object"
        ? (rawP as Record<string, unknown>)
        : undefined;
    activities[step] = {
      idealDays: pInt(p?.idealDays, DEFAULT_IDEAL_DAY),
      yellow: cellFor(p, "yellow", "yellowGrace", DEFAULT_YELLOW_GRACE),
      orange: cellFor(p, "orange", "orangeGrace", DEFAULT_ORANGE_GRACE),
      red: cellFor(p, "red", "redGrace", DEFAULT_RED_GRACE),
      preWarn: migratePreWarn(p?.preWarn),
    };
  }
  return { activities, perSection: migratePerScope(obj.perSection, sequence) };
}

// Resolve the EFFECTIVE numeric grace for one (project, activity). Per-cell
// inheritance: a band the project overrides resolves against the project's
// effective ideal days; an inherited (global) band resolves against the global
// ideal days. AUTO cells derive from their percentage; MANUAL cells use their
// pinned value. The merged row is then ordering-normalized (yellow<=orange<=red).
// With no project (or no override) this is just the global row resolved.
// Resolve a ScopeArg to the concrete (activities, overrides, key) the engine
// should read. A bare string/null means the TLT category (back-compat); a
// ScopeRef selects the TLT top-level config or an NTLT category's config. When
// an NTLT category has no stored config (not seeded yet) it degrades to an empty
// activities map, so per-step lookups fall back to DEFAULT_ACTIVITY_CONFIG.
export function resolveScopeSource(
  settings: TurnaroundSettings,
  scope: ScopeArg,
): {
  activities: Record<string, ActivityConfig>;
  overrides: Record<string, Record<string, PartialActivityConfig>> | undefined;
  key: string | null;
} {
  if (scope == null || typeof scope === "string") {
    return {
      activities: settings.activities,
      overrides: settings.perProject,
      key: scope ?? null,
    };
  }
  const category = scope.category ?? "TLT";
  if (category === "TLT") {
    return {
      activities: settings.activities,
      overrides: settings.perProject,
      key: scope.key ?? null,
    };
  }
  const sub: NtltSubtype =
    scope.ntltSubtype ??
    (category === "NTLT_RSJ"
      ? "RSJ"
      : category === "NTLT_EARTHING"
        ? "EARTHING"
        : "GENERAL");
  const cat = settings.ntlt?.[sub];
  return {
    activities: cat?.activities ?? {},
    overrides: cat?.perSection,
    key: scope.key ?? null,
  };
}

export function resolveActivityGrace(
  settings: TurnaroundSettings,
  scope: ScopeArg,
  step: string,
): ActivityGrace {
  const src = resolveScopeSource(settings, scope);
  const base = src.activities[step] ?? DEFAULT_ACTIVITY_CONFIG;
  const ov = src.key ? src.overrides?.[src.key]?.[step] : undefined;
  const globalIdeal = base.idealDays;
  const effIdeal = ov?.idealDays ?? globalIdeal;

  const band = (key: "yellow" | "orange" | "red"): number => {
    const oc = ov?.[key];
    if (oc) return resolveCell(oc, effIdeal);
    return resolveCell(base[key], globalIdeal);
  };

  return normalizeGrace({
    idealDays: effIdeal,
    yellowGrace: band("yellow"),
    orangeGrace: band("orange"),
    redGrace: band("red"),
  });
}

// Normalize any stored/legacy settings object into the current per-activity
// shape. Accepts the NEW cell shape (`activities[step].{yellow,orange,red}` =
// {mode,percent,value}), the PREVIOUS numeric shape (`yellowGrace`/`orangeGrace`/
// `redGrace` numbers -> MANUAL cells), and the oldest flat shape
// (`{idealDays, yellowMax, orangeMax, overrides}` -> MANUAL cells seeded from the
// global bands, red = orange). Existing explicit grace values therefore become
// MANUAL cells, preserving behaviour until the user opts a cell into a percentage.
export function migrateTurnaroundSettings(raw: unknown): TurnaroundSettings {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const provided = obj.activities as Record<string, unknown> | undefined;
  const legacyIdeal = obj.idealDays as Record<string, number> | undefined;
  const legacyYellow =
    typeof obj.yellowMax === "number" ? obj.yellowMax : undefined;
  const legacyOrange =
    typeof obj.orangeMax === "number" ? obj.orangeMax : undefined;
  const legacyOverrides = (obj.overrides ?? {}) as Record<
    string,
    { yellowMax?: number; orangeMax?: number }
  >;

  const activities: Record<string, ActivityConfig> = {};
  for (const step of PROCESS_SEQUENCE) {
    const rawP = provided?.[step];
    const p =
      rawP && typeof rawP === "object"
        ? (rawP as Record<string, unknown>)
        : undefined;
    const ov = legacyOverrides[step];
    const orange = num(ov?.orangeMax ?? legacyOrange, DEFAULT_ORANGE_GRACE);
    const yellow = num(ov?.yellowMax ?? legacyYellow, DEFAULT_YELLOW_GRACE);
    activities[step] = {
      idealDays: pInt(p?.idealDays, num(legacyIdeal?.[step], DEFAULT_IDEAL_DAY)),
      yellow: cellFor(p, "yellow", "yellowGrace", yellow),
      orange: cellFor(p, "orange", "orangeGrace", orange),
      red: cellFor(p, "red", "redGrace", orange),
      preWarn: migratePreWarn(p?.preWarn),
    };
  }
  const stalledDays = pInt(obj.stalledDays, DEFAULT_STALLED_DAYS);
  const ntltRaw = (obj.ntlt ?? {}) as Record<string, unknown>;
  const ntlt: Partial<Record<NtltSubtype, CategorySettings>> = {
    RSJ: migrateCategorySettings(ntltRaw.RSJ, SEQUENCES.NTLT_RSJ),
    EARTHING: migrateCategorySettings(ntltRaw.EARTHING, SEQUENCES.NTLT_EARTHING),
    GENERAL: migrateCategorySettings(ntltRaw.GENERAL, SEQUENCES.NTLT_GENERAL),
  };
  // Global WIP cutoff: accept a valid YYYY-MM-DD string, else null (no cutoff).
  const rawValidFrom = obj.validFromDate;
  const validFromDate =
    typeof rawValidFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawValidFrom)
      ? rawValidFrom
      : null;
  return {
    activities,
    perProject: migratePerProject(obj.perProject),
    stalledDays,
    ntlt,
    validFromDate,
  };
}

// Resolve the EFFECTIVE pre-warning thresholds for one (project, activity).
// Per-field inheritance: a project override field replaces the global; absent
// fields inherit the global. The merged row is clamped to [0,100] and ordered
// pw1 <= pw2 <= pw3 (raise later bands), mirroring grace resolution.
export function resolvePreWarn(
  settings: TurnaroundSettings,
  scope: ScopeArg,
  step: string,
): PreWarnConfig {
  const src = resolveScopeSource(settings, scope);
  const base = src.activities[step]?.preWarn ?? DEFAULT_PRE_WARN;
  const ov = src.key ? src.overrides?.[src.key]?.[step]?.preWarn : undefined;
  return orderPreWarn({
    pw1: ov?.pw1 ?? base.pw1,
    pw2: ov?.pw2 ?? base.pw2,
    pw3: ov?.pw3 ?? base.pw3,
  });
}

// Effective stalled threshold in days (non-negative integer; default when unset).
export function resolveStalledDays(settings: TurnaroundSettings): number {
  return pInt(settings.stalledDays, DEFAULT_STALLED_DAYS);
}

// Cumulative target per canonical step: sum of ideal-days from the FIRST step up
// to and INCLUDING that step, in PROCESS_SEQUENCE order.
// e.g. C=2, RFI=1, NH=3 -> target(C)=2, target(RFI)=3, target(NH)=6.
// Optional `project` resolves per-project ideal-days overrides; omit (or pass
// null) for the global "All Projects" targets.
export function cumulativeTargets(
  settings: TurnaroundSettings,
  scope?: ScopeArg,
  sequence: ActivitySequence = PROCESS_SEQUENCE,
): Record<string, number> {
  const out: Record<string, number> = {};
  let acc = 0;
  for (const step of sequence) {
    acc += safeDays(resolveActivityGrace(settings, scope, step).idealDays);
    out[step] = acc;
  }
  return out;
}

// Cumulative target for a single activity (case-insensitive). Returns null for
// activities outside PROCESS_SEQUENCE — they have no defined target. Optional
// `project` applies that project's ideal-days overrides.
export function cumulativeTarget(
  activity: string | null | undefined,
  settings: TurnaroundSettings,
  scope?: ScopeArg,
  sequence: ActivitySequence = PROCESS_SEQUENCE,
): number | null {
  if (!isKnownIn(sequence, activity)) return null;
  const norm = normalizeActivity(activity);
  return cumulativeTargets(settings, scope, sequence)[norm] ?? null;
}

// Classify a mark's ageing against its cumulative target using THAT activity's
// own grace. Rows with no target (out-of-sequence activity) or no ageing (blank
// production date -> ageingDays null) are "na". Future-dated rows are clamped to
// ageing 0 upstream and therefore land in green.
//   overrun = ageingDays - cumulativeTarget(activity)
//   overrun <= 0            -> green
//   overrun <= yellowGrace  -> yellow
//   overrun <= orangeGrace  -> orange
//   overrun >  orangeGrace  -> red
export function alertStatus(
  input: {
    activity: string | null | undefined;
    ageingDays: number | null;
    project?: string | null;
    // Full resolution scope (category + override key). When present it takes
    // precedence over `project`; otherwise `project` is treated as a TLT project.
    scope?: ScopeRef;
    // The mark's process sequence (per category). Defaults to TLT so existing
    // callers stay unchanged; pass an NTLT sequence for RSJ/Earthing/General rows.
    sequence?: ActivitySequence;
  },
  settings: TurnaroundSettings,
): AlertResult {
  const sequence = input.sequence ?? PROCESS_SEQUENCE;
  const scope: ScopeArg = input.scope ?? input.project;
  const target = cumulativeTarget(input.activity, settings, scope, sequence);
  if (target === null || input.ageingDays === null) {
    return { status: "na", target, overrun: null };
  }

  const overrun = input.ageingDays - target;
  const norm = normalizeActivity(input.activity);
  const grace = resolveActivityGrace(settings, scope, norm);

  let status: AlertStatus;
  if (overrun <= 0) status = "green";
  else if (overrun <= grace.yellowGrace) status = "yellow";
  else if (overrun <= grace.orangeGrace) status = "orange";
  else status = "red";

  return { status, target, overrun };
}

// ---------------------------------------------------------------------------
// Lifecycle status — the full 8-state ladder
// ---------------------------------------------------------------------------
// A SUPERSET view layered on top of alertStatus (the breach engine, untouched).
// While a mark is still within target (overrun <= 0) it is classified by how much
// of its cumulative target it has CONSUMED (ageing / target), against the
// per-activity pre-warning thresholds. Once the target is exceeded (overrun > 0)
// the existing grace bands take over — yellow/orange/red are simply renamed
// breach1/breach2/breach3 here so the ladder reads as one escalating sequence.
//
//   na                                  -> no target or no ageing
//   within target (overrun <= 0):
//     consumed < pw1                    -> green
//     pw1 <= consumed < pw2             -> prewarn1
//     pw2 <= consumed < pw3             -> prewarn2
//     pw3 <= consumed (<= 100)          -> prewarn3
//   over target (overrun > 0):
//     alertStatus yellow/orange/red     -> breach1/breach2/breach3
//
// Breach classification is delegated verbatim to alertStatus, so pre-warning is
// strictly ADDITIVE and never changes breach bands, targets, ageing, or n/a.
export type LifecycleStatus =
  | "green"
  | "prewarn1"
  | "prewarn2"
  | "prewarn3"
  | "breach1"
  | "breach2"
  | "breach3"
  | "na";

// Canonical render order (best -> worst) for legends, summaries and sorting.
export const LIFECYCLE_ORDER: LifecycleStatus[] = [
  "green",
  "prewarn1",
  "prewarn2",
  "prewarn3",
  "breach1",
  "breach2",
  "breach3",
  "na",
];

export interface LifecycleResult {
  status: LifecycleStatus;
  target: number | null;
  overrun: number | null;
  // Percent of the cumulative target consumed (round(ageing/target*100)); null
  // when there is no usable target (na, or target 0).
  consumedPct: number | null;
  // Projected days remaining before the target is reached (max(0, target -
  // ageing)); 0 once breached; null when na.
  daysToTarget: number | null;
}

const BREACH_BY_ALERT: Record<"yellow" | "orange" | "red", LifecycleStatus> = {
  yellow: "breach1",
  orange: "breach2",
  red: "breach3",
};

export function lifecycleStatus(
  input: {
    activity: string | null | undefined;
    ageingDays: number | null;
    project?: string | null;
    // Full resolution scope (category + override key). Takes precedence over
    // `project` when present; otherwise `project` is treated as a TLT project.
    scope?: ScopeRef;
    // The mark's process sequence (per category). Defaults to TLT; pass an NTLT
    // sequence for RSJ/Earthing/General rows.
    sequence?: ActivitySequence;
  },
  settings: TurnaroundSettings,
): LifecycleResult {
  const base = alertStatus(input, settings);
  const { target, overrun } = base;

  if (base.status === "na" || target === null || input.ageingDays === null) {
    return { status: "na", target, overrun, consumedPct: null, daysToTarget: null };
  }

  const ageing = input.ageingDays;
  const consumedPct = target > 0 ? Math.round((ageing / target) * 100) : null;

  // Breach phase: reuse the breach engine's band verbatim.
  if ((overrun ?? 0) > 0) {
    const status =
      base.status === "green" ? "green" : BREACH_BY_ALERT[base.status];
    return { status, target, overrun, consumedPct, daysToTarget: 0 };
  }

  // Within-target phase: classify by consumed percentage of the target.
  const daysToTarget = Math.max(0, target - ageing);
  if (target <= 0) {
    return { status: "green", target, overrun, consumedPct, daysToTarget };
  }

  const consumed = (ageing / target) * 100;
  const pw = resolvePreWarn(
    settings,
    input.scope ?? input.project,
    normalizeActivity(input.activity),
  );

  let status: LifecycleStatus;
  if (consumed < pw.pw1) status = "green";
  else if (consumed < pw.pw2) status = "prewarn1";
  else if (consumed < pw.pw3) status = "prewarn2";
  else status = "prewarn3";

  return { status, target, overrun, consumedPct, daysToTarget };
}

// ---------------------------------------------------------------------------
// Velocity engine — pace / pace-based ETA / trend (deterministic)
// ---------------------------------------------------------------------------
// A mark's VELOCITY is derived from MULTIPLE snapshots over time (the upload /
// change-log history): how fast it advances down PROCESS_SEQUENCE. This layer is
// purely additive and read-time — it NEVER changes parsing, Activity values,
// dedup, ageing, or the alert/threshold/lifecycle math above. The functions here
// are pure: the backend walks import history to build the per-mark snapshot
// series, then this engine computes pace, a pace-based ETA, the gap vs the
// budget-based target, a trend, and a movement status. AI may comment on the
// result, never set it.

// MOVING: advancing at/around its expected pace. SLOW: moving but materially
// slower than its expected pace. STALLED: no movement for >= stalledDays.
// insufficient: fewer than 2 usable snapshots (cold start — no pace/ETA).
export type VelocityStatus = "moving" | "slow" | "stalled" | "insufficient";

// Direction of the recent pace vs the earlier pace. "stalled" when there is no
// recent movement; "unknown" when there is not enough history to compare.
export type VelocityTrend =
  | "accelerating"
  | "steady"
  | "decelerating"
  | "stalled"
  | "unknown";

// One historical observation of a mark (one import it appeared in).
export interface VelocitySnapshot {
  // Epoch ms of the import this observation came from (report date, fallback
  // upload time). Used as the time axis for pace.
  importDate: number;
  // Position of the mark's activity in PROCESS_SEQUENCE at that snapshot
  // (activityRank); PROCESS_SEQUENCE.length for an unknown activity.
  stageIndex: number;
  // The mark's last production date string at that snapshot (movement signal).
  lastProductionDate: string | null;
}

export interface VelocityInput {
  // Snapshot series (any order; sorted ascending by importDate internally).
  series: VelocitySnapshot[];
  // Current activity code (case-insensitive) — drives stages-remaining + target.
  activity: string | null | undefined;
  // Current live ageing (today - last production date); null when no date.
  ageingDays: number | null;
  // Days since the mark last moved (from the history walk); null when unknown.
  daysSinceLastMovement: number | null;
  // Optional route-aware steps remaining (overrides the sequence default).
  routeRemaining?: number | null;
  // Project key for per-project ideal-days / stalled resolution.
  project?: string | null;
  // Full resolution scope (category + override key). Takes precedence over
  // `project` when present; otherwise `project` is treated as a TLT project.
  scope?: ScopeRef;
  // The mark's process sequence (per category). Defaults to TLT; pass an NTLT
  // sequence for RSJ/Earthing/General rows so stages-remaining + expected pace
  // are measured against the correct route. NOTE: snapshot stageIndex values
  // MUST be computed against this same sequence by the caller.
  sequence?: ActivitySequence;
}

export interface VelocityResult {
  status: VelocityStatus;
  trend: VelocityTrend;
  // Observed days per advanced stage; null when no measurable advance / cold start.
  daysPerStage: number | null;
  // Expected days per stage from the ideal-days settings (resolved per project).
  expectedDaysPerStage: number | null;
  // Stages left to reach Yard (route-aware when provided); null for unknown activity.
  stagesRemaining: number | null;
  // Projected days from today to completion at the observed pace; null when the
  // mark is not moving or has no measurable pace.
  etaDays: number | null;
  // etaDays - budget days-to-target. > 0 => projected LATE by that many days.
  etaGap: number | null;
  // Span (days) of the snapshot window the pace was measured over.
  observedWindowDays: number | null;
  // Number of snapshots used.
  snapshotsUsed: number;
  // Days since last movement, echoed through for display.
  daysSinceLastMovement: number | null;
  // True when there are fewer than 2 usable snapshots (no fabricated ETA).
  insufficientHistory: boolean;
}

// A mark is SLOW when its observed pace exceeds its expected pace by at least
// this factor (25% slower than expected).
export const DEFAULT_SLOW_FACTOR = 1.25;
// Recent vs earlier pace within this relative band reads as "steady".
const TREND_STEADY_BAND = 0.1;
const MS_PER_DAY = 86_400_000;

function daysBetween(aMs: number, bMs: number): number {
  return (bMs - aMs) / MS_PER_DAY;
}

// Mean resolved ideal-days over the inclusive step range [fromRank, toRank] of
// the given sequence.
function expectedPaceForRange(
  settings: TurnaroundSettings,
  scope: ScopeArg,
  fromRank: number,
  toRank: number,
  sequence: ActivitySequence,
): number | null {
  const finalRank = sequence.length - 1;
  const lo = Math.max(0, Math.min(fromRank, toRank));
  const hi = Math.min(finalRank, Math.max(fromRank, toRank));
  const steps: number[] = [];
  for (let i = lo; i <= hi; i++) {
    const step = sequence[i];
    steps.push(safeDays(resolveActivityGrace(settings, scope, step).idealDays));
  }
  if (steps.length === 0) return null;
  const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
  return mean > 0 ? mean : null;
}

// Observed pace (days per advanced stage) over a sorted sub-series. Returns null
// when there is no net forward stage advance in the window.
function paceOver(series: VelocitySnapshot[]): number | null {
  if (series.length < 2) return null;
  const first = series[0];
  const last = series[series.length - 1];
  const advanced = last.stageIndex - first.stageIndex;
  if (advanced <= 0) return null;
  const days = daysBetween(first.importDate, last.importDate);
  if (days <= 0) return null;
  return days / advanced;
}

// Compute the full velocity result for one mark from its snapshot series.
// Deterministic and pure. Degrades gracefully: < 2 usable snapshots =>
// insufficientHistory (no ETA); no measurable advance => not moving (stalled or
// no-pace) rather than a fabricated pace.
export function velocityForMark(
  input: VelocityInput,
  settings: TurnaroundSettings,
): VelocityResult {
  const stalledDays = resolveStalledDays(settings);
  const series = [...input.series]
    .filter((s) => Number.isFinite(s.importDate))
    .sort((a, b) => a.importDate - b.importDate);

  const sequence = input.sequence ?? PROCESS_SEQUENCE;
  const finalRank = sequence.length - 1;
  const currentRank = rankIn(sequence, input.activity);
  const knownActivity = isKnownIn(sequence, input.activity);
  const stagesRemaining = knownActivity
    ? input.routeRemaining != null && input.routeRemaining >= 0
      ? Math.round(input.routeRemaining)
      : Math.max(0, finalRank - currentRank)
    : null;

  const movedRecently =
    input.daysSinceLastMovement != null &&
    input.daysSinceLastMovement < stalledDays;
  const isStalled =
    input.daysSinceLastMovement != null &&
    input.daysSinceLastMovement >= stalledDays;

  const base = {
    stagesRemaining,
    daysSinceLastMovement: input.daysSinceLastMovement,
    snapshotsUsed: series.length,
  };

  // Cold start: not enough history to compute any pace.
  if (series.length < 2) {
    return {
      ...base,
      status: isStalled ? "stalled" : "insufficient",
      trend: "unknown",
      daysPerStage: null,
      expectedDaysPerStage: null,
      etaDays: null,
      etaGap: null,
      observedWindowDays: null,
      insufficientHistory: true,
    };
  }

  const firstRank = series[0].stageIndex;
  const observedWindowDays = daysBetween(
    series[0].importDate,
    series[series.length - 1].importDate,
  );
  const scope: ScopeArg = input.scope ?? input.project;
  const daysPerStage = paceOver(series);
  const expectedDaysPerStage = expectedPaceForRange(
    settings,
    scope,
    firstRank,
    currentRank,
    sequence,
  );

  // ETA + gap (only when we have a real pace, a target stage, and ageing).
  let etaDays: number | null = null;
  let etaGap: number | null = null;
  if (daysPerStage != null && stagesRemaining != null) {
    etaDays = daysPerStage * stagesRemaining;
    const target = cumulativeTarget(input.activity, settings, scope, sequence);
    if (target != null && input.ageingDays != null) {
      const budgetDaysToTarget = target - input.ageingDays;
      etaGap = etaDays - budgetDaysToTarget;
    }
  }

  // Trend: recent (last 2 snapshots) vs earlier pace.
  let trend: VelocityTrend;
  if (isStalled || (!movedRecently && daysPerStage == null)) {
    trend = "stalled";
  } else {
    const recentPace = paceOver(series.slice(-2));
    const earlierPace = paceOver(series.slice(0, -1));
    if (recentPace == null || earlierPace == null) {
      trend = "unknown";
    } else {
      const rel = (recentPace - earlierPace) / earlierPace;
      if (rel < -TREND_STEADY_BAND) trend = "accelerating";
      else if (rel > TREND_STEADY_BAND) trend = "decelerating";
      else trend = "steady";
    }
  }

  // Movement status.
  let status: VelocityStatus;
  if (isStalled) {
    status = "stalled";
  } else if (
    daysPerStage != null &&
    expectedDaysPerStage != null &&
    daysPerStage > expectedDaysPerStage * DEFAULT_SLOW_FACTOR
  ) {
    status = "slow";
  } else {
    status = "moving";
  }

  return {
    ...base,
    status,
    trend,
    daysPerStage,
    expectedDaysPerStage,
    etaDays,
    etaGap,
    observedWindowDays,
    insufficientHistory: false,
  };
}

// ---------------------------------------------------------------------------
// Thickness resolution (Phase 3, additive; display/config only). Thickness (mm)
// is derived live per row from the row's category/section plus two config
// lookups -- it is NEVER stored on the pool row and NEVER part of the row hash,
// exactly like live ageing. Editing thickness never changes qty/activity/ageing.
// ---------------------------------------------------------------------------

export type ThicknessSource =
  | "tlt_angle"
  | "tlt_plate"
  | "rsj_exact"
  | "rsj_base"
  | "rsj_default"
  | "manual"
  | "unset";

// Fallback galvanizing thickness (mm) for an NTLT/RSJ row whose cleaned type has
// neither an exact nor an unambiguous base match in the lookup table.
export const RSJ_DEFAULT_THICKNESS_MM = 6.0;

// Known RSJ types pre-seeded into the lookup table so the resolution cascade has
// something to match against out of the box (exact + base match). Every other
// variation inherits by base ("RSJ <A>X<B>") or falls back to the 6.0 default;
// a manual pin always wins. Seeded with onConflictDoNothing on groupKey, so any
// in-app edit to a value is preserved and re-seeding on boot is a no-op. Keys
// are the cleaned, uppercased "RSJ <dims>" form parse.ts produces.
export const RSJ_THICKNESS_SEED: { groupKey: string; thicknessMm: number }[] = [
  { groupKey: "RSJ 203X203X16", thicknessMm: 7.6 },
  { groupKey: "RSJ 160X160X13", thicknessMm: 6.0 },
  { groupKey: "RSJ 152X152X15", thicknessMm: 7.9 },
  { groupKey: "RSJ 200X100X9", thicknessMm: 6.0 },
  { groupKey: "RSJ 100X116X10", thicknessMm: 6.0 },
  { groupKey: "RSJ 204X206X11", thicknessMm: 7.6 },
];

export interface ThicknessResult {
  thicknessMm: number | null;
  thicknessSource: ThicknessSource;
}

// Angle section "A X B X C" -> C (the last dimension). Tolerates decimals and
// surrounding text; requires at least the three X-separated numbers.
export function parseAngleThickness(section: string | null | undefined): number | null {
  if (!section) return null;
  const m = section
    .toUpperCase()
    .match(/(\d+(?:\.\d+)?)\s*X\s*(\d+(?:\.\d+)?)\s*X\s*(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const v = Number(m[3]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

// Plate spec "PLATE <n> MM" -> n (case-insensitive). Returns null if absent.
export function parsePlateThickness(section: string | null | undefined): number | null {
  if (!section) return null;
  const m = section.toUpperCase().match(/PLATE\s+(\d+(?:\.\d+)?)\s*MM/);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

// ---------------------------------------------------------------------------
// Hole operation (PUNCHING / DRILLING) — derived, display/report-only.
//
// A deterministic per-mark attribute derived purely from the immutable Section
// string (NOT manual pins / RSJ lookups), so a stored value stays stable across
// re-imports and never depends on mutable config. NOT part of the row hash.
// Lets data be sorted / filtered / reported by punching vs drilling.
// ---------------------------------------------------------------------------

export type SectionType =
  | "ANGLE"
  | "PLATE"
  | "CHANNEL"
  | "BEAM"
  | "RSJ"
  | "FLAT"
  | "PIPE"
  | "ROUND"
  | "GRATING"
  | "OTHER";

export type HoleOperation = "PUNCHING" | "DRILLING" | "NOT_SET";

export type HoleOperationSource =
  | "rule_thickness"
  | "rule_fixed"
  | "not_applicable"
  | "unknown";

// Fixed cutoff: <= 12 mm -> punching, > 12 mm -> drilling (no gap; decimals ok).
export const HOLE_OPERATION_THICKNESS_CUTOFF_MM = 12;

// Detect the section family from the (uppercased, trimmed) Section text. Priority
// order is significant: PLATE wins over everything (incl. "CHQ. PLATE"); the
// angle pattern is the last specific test before the OTHER fallback.
export function detectSectionType(
  section: string | null | undefined,
): SectionType {
  if (!section) return "OTHER";
  const s = section.toUpperCase().trim();
  if (!s) return "OTHER";
  if (s.includes("PLATE")) return "PLATE";
  if (s.startsWith("RSJ")) return "RSJ";
  if (s.includes("ISMC")) return "CHANNEL";
  if (s.includes("ISMB")) return "BEAM";
  if (s.startsWith("FLAT")) return "FLAT";
  if (s.includes("PIPE")) return "PIPE";
  if (s.includes("ROUND")) return "ROUND";
  if (s.includes("GRATING")) return "GRATING";
  if (/^A?\s*\d+X\d+X[\d.]+/.test(s)) return "ANGLE";
  return "OTHER";
}

export interface HoleOperationResult {
  sectionType: SectionType;
  holeOperation: HoleOperation;
  holeOperationSource: HoleOperationSource;
}

// Derive the hole operation for a mark from its Section alone. Channel/Beam/RSJ
// are always drilled; Angle/Plate use the thickness cutoff (last angle dim /
// plate number; <= 12 -> punch, > 12 -> drill); everything else is NOT_SET (not
// applicable yet). An Angle/Plate whose thickness can't be parsed is
// NOT_SET/"unknown" (flagged for review, never guessed).
export function deriveHoleOperation(
  section: string | null | undefined,
): HoleOperationResult {
  const sectionType = detectSectionType(section);
  switch (sectionType) {
    case "CHANNEL":
    case "BEAM":
    case "RSJ":
      return {
        sectionType,
        holeOperation: "DRILLING",
        holeOperationSource: "rule_fixed",
      };
    case "ANGLE":
    case "PLATE": {
      const thickness =
        sectionType === "ANGLE"
          ? parseAngleThickness(section)
          : parsePlateThickness(section);
      if (thickness == null) {
        return {
          sectionType,
          holeOperation: "NOT_SET",
          holeOperationSource: "unknown",
        };
      }
      const holeOperation: HoleOperation =
        thickness <= HOLE_OPERATION_THICKNESS_CUTOFF_MM ? "PUNCHING" : "DRILLING";
      return { sectionType, holeOperation, holeOperationSource: "rule_thickness" };
    }
    default:
      return {
        sectionType,
        holeOperation: "NOT_SET",
        holeOperationSource: "not_applicable",
      };
  }
}

// Section-derived thickness shared by TLT and NTLT/Earthing: angle first, then
// plate. Returns the value + which pattern matched (null/unset if neither).
function sectionThickness(section: string | null | undefined): ThicknessResult {
  const angle = parseAngleThickness(section);
  if (angle != null) return { thicknessMm: angle, thicknessSource: "tlt_angle" };
  const plate = parsePlateThickness(section);
  if (plate != null) return { thicknessMm: plate, thicknessSource: "tlt_plate" };
  return { thicknessMm: null, thicknessSource: "unset" };
}

export interface ThicknessInput {
  category: string | null;
  ntltSubtype: string | null;
  section: string | null;
  groupKey: string | null;
  markId: string;
}

export interface ThicknessLookups {
  // Cleaned "RSJ <dims>" groupKey -> thickness (mm).
  rsjByKey?: Map<string, number>;
  // mark_id -> manually pinned thickness (mm). Survives re-imports.
  manualByMarkId?: Map<string, number>;
  // RSJ base ("RSJ <A>X<B>", first two dims) -> thickness (mm), built from the
  // exact table so unlisted variations inherit their base's value.
  rsjBaseByKey?: Map<string, number>;
  // Bases that map to >1 distinct thickness in the table -- never guessed.
  ambiguousRsjBases?: Set<string>;
}

// Base of a cleaned RSJ type = its first two dimensions only ("RSJ <A>X<B>"),
// dropping the third dim and any trailing junk. Case/space-insensitive. Returns
// null when the key has no recognizable "<A>X<B>" pair.
export function rsjBase(key: string | null | undefined): string | null {
  if (!key) return null;
  const m = key
    .toUpperCase()
    .match(/(\d+(?:\.\d+)?)\s*X\s*(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return `RSJ ${m[1]}X${m[2]}`;
}

// Build the base -> thickness index from the exact RSJ table. A base resolves
// only when every listed type sharing it agrees on one thickness; bases with
// conflicting thicknesses are returned as ambiguous (resolver uses the default
// and flags them for manual entry).
export function buildRsjBaseIndex(rsjByKey: Map<string, number>): {
  rsjBaseByKey: Map<string, number>;
  ambiguousRsjBases: Set<string>;
} {
  const byBase = new Map<string, Set<number>>();
  for (const [key, mm] of rsjByKey) {
    if (!(Number.isFinite(mm) && mm > 0)) continue;
    const base = rsjBase(key);
    if (!base) continue;
    if (!byBase.has(base)) byBase.set(base, new Set());
    byBase.get(base)!.add(mm);
  }
  const rsjBaseByKey = new Map<string, number>();
  const ambiguousRsjBases = new Set<string>();
  for (const [base, vals] of byBase) {
    if (vals.size === 1) rsjBaseByKey.set(base, vals.values().next().value as number);
    else ambiguousRsjBases.add(base);
  }
  return { rsjBaseByKey, ambiguousRsjBases };
}

// The single resolver: decide a row's thickness + source. A manual pin (keyed by
// mark_id) always wins (explicit user intent). Otherwise resolve by category:
//   TLT            -> section (angle last-dim / plate number)
//   NTLT/EARTHING  -> section (same as TLT)
//   NTLT/RSJ       -> exact table match -> base match (first two dims) -> 6.0
//                     default (NOT the section dims)
//   NTLT/GENERAL   -> manual only; unset until entered
// Anything else / unparseable -> null + "unset" (never guessed, surfaced as a gap).
export function resolveThickness(
  row: ThicknessInput,
  lookups: ThicknessLookups = {},
): ThicknessResult {
  const manual = lookups.manualByMarkId?.get(row.markId);
  if (manual != null && Number.isFinite(manual) && manual > 0) {
    return { thicknessMm: manual, thicknessSource: "manual" };
  }

  const cat = (row.category ?? "").toUpperCase();
  const sub = (row.ntltSubtype ?? "").toUpperCase();

  if (cat === "TLT") return sectionThickness(row.section);

  if (cat === "NTLT") {
    if (sub === "EARTHING") return sectionThickness(row.section);
    if (sub === "RSJ") {
      const key = row.groupKey ?? "";
      // 1) Exact cleaned-type match in the lookup table.
      const exact = lookups.rsjByKey?.get(key);
      if (exact != null && Number.isFinite(exact) && exact > 0) {
        return { thicknessMm: exact, thicknessSource: "rsj_exact" };
      }
      // 2) Base match: inherit from any listed type sharing the first two dims
      // (skip ambiguous bases that map to >1 thickness).
      const base = rsjBase(key);
      if (base && !lookups.ambiguousRsjBases?.has(base)) {
        const bv = lookups.rsjBaseByKey?.get(base);
        if (bv != null && Number.isFinite(bv) && bv > 0) {
          return { thicknessMm: bv, thicknessSource: "rsj_base" };
        }
      }
      // 3) Default.
      return {
        thicknessMm: RSJ_DEFAULT_THICKNESS_MM,
        thicknessSource: "rsj_default",
      };
    }
    // GENERAL (and any other NTLT subtype) is manual-only -> unset until pinned.
    return { thicknessMm: null, thicknessSource: "unset" };
  }

  return { thicknessMm: null, thicknessSource: "unset" };
}

// Shared record filtering + aggregation (client + server single source of truth).
export * from "./aggregate";
