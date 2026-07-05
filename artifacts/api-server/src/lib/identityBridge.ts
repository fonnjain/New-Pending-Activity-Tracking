// Bridges a genuine gap in the markId+jobCardNo identity used across the
// change log (diff.ts) and the contractor movement ledger
// (contractorMovement.ts): this shop reissues a fresh job card every time a
// TLT mark advances to its next fabrication/galvanizing operation, so the
// same physical mark's compound identity changes mid-route. Left unbridged,
// every one of those real moves looks like "old identity disappeared" +
// "new identity appeared" -- never a move -- which silently drops
// Fabrication-stage activity everywhere that keys off this identity.
//
// A canonical identity survives a job-card change only when it's
// unambiguous: for a given markId, exactly one of its previously-seen job
// cards vanishes and exactly one brand-new job card appears in the very
// next import. Anything else (0 or 2+ simultaneous candidates for the same
// markId) is left unbridged and tracked as distinct identities, same as
// before this fix -- we never guess when there's more than one candidate.

export interface IdentityRow {
  markId: string;
  jobCardNo: string | null;
}

export function identityRawKey(markId: string, jobCardNo: string | null): string {
  return `${markId}\u0001${jobCardNo ?? ""}`;
}

// Given a sequence of imports (each a flat list of markId/jobCardNo pairs,
// duplicates allowed), returns one Map per import: rawKey -> canonical
// identity key to use for cross-import continuity tracking. The canonical
// key for a mark's very first appearance is its own raw key.
export function buildIdentityBridge(perImportRows: IdentityRow[][]): Map<string, string>[] {
  const canonicalOf = new Map<string, string>();
  const result: Map<string, string>[] = [];
  let prevKeysByMark = new Map<string, Set<string>>();

  for (const rows of perImportRows) {
    const curKeysByMark = new Map<string, Set<string>>();
    for (const r of rows) {
      const rk = identityRawKey(r.markId, r.jobCardNo);
      let set = curKeysByMark.get(r.markId);
      if (!set) {
        set = new Set();
        curKeysByMark.set(r.markId, set);
      }
      set.add(rk);
    }

    for (const [markId, prevKeys] of prevKeysByMark) {
      const curKeys = curKeysByMark.get(markId);
      if (!curKeys) continue;
      const lost = [...prevKeys].filter((k) => !curKeys.has(k));
      const gained = [...curKeys].filter((k) => !canonicalOf.has(k));
      if (lost.length === 1 && gained.length === 1) {
        const canon = canonicalOf.get(lost[0]) ?? lost[0];
        canonicalOf.set(gained[0], canon);
      }
    }

    const mapForImport = new Map<string, string>();
    for (const keys of curKeysByMark.values()) {
      for (const rk of keys) {
        if (!canonicalOf.has(rk)) canonicalOf.set(rk, rk);
        mapForImport.set(rk, canonicalOf.get(rk)!);
      }
    }
    result.push(mapForImport);
    prevKeysByMark = curKeysByMark;
  }

  return result;
}
