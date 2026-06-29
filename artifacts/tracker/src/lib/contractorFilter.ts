// Shared contractor-filter model used by every contractor dropdown (the global
// FilterBar and any page-local contractor selector). Defining the grouped
// options, the value encoding, and the match predicate ONCE guarantees the
// dropdown order and the virtual "In-House" semantics never drift across pages.
//
// "In-House" is a VIRTUAL roll-up (stored category CNC OR SUB_CONTRACTOR). It is
// a filter-only shortcut value — never a stored ContractorCategory. This module
// is display/filter only and never mutates contractor strings or storage.
//
// Category option values are NAMESPACED with a prefix (e.g. `cat:CNC`) so they
// can never collide with a real contractor name that happens to equal a category
// token. Encode/decode is centralized here; callers treat the value opaquely.
import {
  IN_HOUSE_GROUP,
  matchesContractorCategoryFilter,
} from "@workspace/domain";
import type { SelectGroup } from "@/components/ui/searchable-select";
import {
  contractorCategoryFor,
  type ContractorCategoryInfo,
} from "@/lib/store";

const CATEGORY_VALUE_PREFIX = "cat:";

// Encode a category token into a namespaced dropdown value.
export function encodeContractorCategory(token: string): string {
  return `${CATEGORY_VALUE_PREFIX}${token}`;
}

// Decode a dropdown value to its category token, or null if it is not a category
// selection (i.e. it is a specific contractor name or null).
export function decodeContractorCategory(
  value: string | null | undefined,
): string | null {
  if (value && value.startsWith(CATEGORY_VALUE_PREFIX)) {
    return value.slice(CATEGORY_VALUE_PREFIX.length);
  }
  return null;
}

// Classification shortcuts shown ABOVE the individual contractor names, in the
// required order: In-House (combined + members) -> Out Vendors -> Everything else.
const IN_HOUSE_OPTIONS = [
  { value: encodeContractorCategory(IN_HOUSE_GROUP), label: "In-House (CNC + Sub-contractor)" },
  { value: encodeContractorCategory("CNC"), label: "CNC" },
  { value: encodeContractorCategory("SUB_CONTRACTOR"), label: "Sub-contractor" },
];
const OUT_VENDOR_OPTIONS = [
  { value: encodeContractorCategory("OUT_VENDOR"), label: "Out-vendor" },
];
const EVERYTHING_ELSE_OPTIONS = [
  { value: encodeContractorCategory("UNCLASSIFIED"), label: "Everything else (Unclassified)" },
];

// Build the grouped SearchableSelect options: the classification shortcuts in
// canonical order first, then the individual contractor names.
export function buildContractorGroups(contractors: string[]): SelectGroup[] {
  return [
    { heading: "In-House", options: IN_HOUSE_OPTIONS },
    { heading: "Out Vendors", options: OUT_VENDOR_OPTIONS },
    { heading: "Everything else", options: EVERYTHING_ELSE_OPTIONS },
    { heading: "Contractors", options: contractors.map((c) => ({ value: c, label: c })) },
  ];
}

// Single-state contractor predicate for page-local filters: a namespaced
// category value matches via the (virtual-aware) category helper; any other
// value is an exact contractor-name match; null/empty matches everything.
export function matchesContractorSelection(
  contractor: string | null | undefined,
  selection: string | null,
  map: Map<string, ContractorCategoryInfo>,
): boolean {
  if (!selection) return true;
  const category = decodeContractorCategory(selection);
  if (category !== null) {
    return matchesContractorCategoryFilter(
      contractorCategoryFor(contractor, map).category,
      category,
    );
  }
  return contractor === selection;
}
