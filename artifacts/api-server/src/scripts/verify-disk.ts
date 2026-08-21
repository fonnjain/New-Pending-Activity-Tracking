/**
 * Disk verification script — DC6, DC16, DC17, DC12-14
 * Reads the attached WIP and OR files for 12-Aug, 13-Aug, 14-Aug
 * and prints the same check numbers the live DC endpoint would produce.
 *
 * Run:  pnpm --filter @workspace/api-server tsx src/scripts/verify-disk.ts
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { parseWorkbook } from "../lib/parse";
import { parseOrderReview } from "../lib/parse-order-review";
import {
  PROCESS_SEQUENCE,
  QC_ACTIVITY_SET,
  GALV_ACTIVITY_SET,
  classifyNtltStage,
  classifyDc17,
} from "@workspace/domain";

// ─── File paths ──────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../../../../attached_assets");

const FILES: { date: string; wip: string; or: string }[] = [
  {
    date: "12-Aug-2026",
    wip: "WIP_12-08-2026_1786694736852.xls",
    or: "Order_Review_12-08-2026_1786694736852.xlsx",
  },
  {
    date: "13-Aug-2026",
    wip: "WIP_13-08-2026_1786694749706.xls",
    or: "Order_Review_13-08-2026_1786694749705.xlsx",
  },
  {
    date: "14-Aug-2026",
    wip: "WIP-14-08-2026_1786694760773.xls",
    or: "Order_Review-14-08-2026_1786694760773.xlsx",
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FG_RANK = PROCESS_SEQUENCE.length; // 12

function actRank(activity: string | null | undefined, jct: string | null | undefined): number {
  if ((jct ?? "").trim().toLowerCase() === "fg pending for dispatch") return FG_RANK;
  const act = (activity ?? "").trim().toUpperCase();
  const idx = (PROCESS_SEQUENCE as readonly string[]).indexOf(act);
  return idx >= 0 ? idx : -1;
}

function fmt(n: number, dec = 3) {
  return n.toFixed(dec).padStart(12);
}
function fmtN(n: number) {
  return String(n).padStart(8);
}

// ─── DC6 — TLT six-bucket partition ──────────────────────────────────────────

function dc6(rows: ReturnType<typeof parseWorkbook>["rows"], date: string) {
  const buckets: Record<string, { mt: number; marks: number }> = {
    "Release":            { mt: 0, marks: 0 },
    "Awaiting Assignment":{ mt: 0, marks: 0 },
    "Cutting":            { mt: 0, marks: 0 },
    "Quality Check":      { mt: 0, marks: 0 },
    "Galvanising":        { mt: 0, marks: 0 },
    "FG (WIP file)":      { mt: 0, marks: 0 },
  };
  let total = 0, totalMarks = 0, unclassified = 0;

  for (const r of rows) {
    if (r.category !== "TLT") continue;
    const wMt = (r.balanceWt ?? 0) / 1000;
    total += wMt;
    totalMarks++;

    const tp = (r.jobCardType ?? "").trim().toLowerCase();
    const st = (r.jobCardStatus ?? "").trim().toLowerCase();
    const a  = (r.activity ?? "").trim().toUpperCase();
    const contr = (r.contractor ?? "").trim();

    if (tp === "job card not started" && st === "initial") {
      buckets["Release"].mt += wMt; buckets["Release"].marks++;
    } else if (tp === "job card not started" && st === "authorized") {
      if (contr === "") { buckets["Awaiting Assignment"].mt += wMt; buckets["Awaiting Assignment"].marks++; }
      else              { buckets["Cutting"].mt += wMt; buckets["Cutting"].marks++; }
    } else if (tp === "job card wip" && QC_ACTIVITY_SET.has(a)) {
      buckets["Quality Check"].mt += wMt; buckets["Quality Check"].marks++;
    } else if (tp === "job card wip" && GALV_ACTIVITY_SET.has(a)) {
      buckets["Galvanising"].mt += wMt; buckets["Galvanising"].marks++;
    } else if (tp === "fg pending for dispatch") {
      buckets["FG (WIP file)"].mt += wMt; buckets["FG (WIP file)"].marks++;
    } else {
      unclassified++;
    }
  }

  const bucketSum = Object.values(buckets).reduce((s, b) => s + b.mt, 0);
  const pass = unclassified === 0 && Math.abs(total - bucketSum) < 0.001;

  console.log(`\n━━━ DC6  TLT six-bucket — ${date} ━━━`);
  for (const [name, b] of Object.entries(buckets)) {
    console.log(`  ${name.padEnd(22)} ${fmt(b.mt)} MT  ${fmtN(b.marks)} marks`);
  }
  console.log(`  ${"TOTAL".padEnd(22)} ${fmt(total)} MT  ${fmtN(totalMarks)} marks`);
  console.log(`  Bucket sum:           ${fmt(bucketSum)} MT   diff: ${(total - bucketSum).toFixed(3)}`);
  console.log(`  Unclassified:         ${unclassified}   → ${pass ? "✅ PASS" : "❌ FAIL"}`);
}

// ─── DC16 — NTLT five-stage partition ────────────────────────────────────────

function dc16(rows: ReturnType<typeof parseWorkbook>["rows"], date: string) {
  const stages: Record<string, { mt: number; marks: number }> = {
    notStarted:  { mt: 0, marks: 0 },
    ts:          { mt: 0, marks: 0 },
    galvanising: { mt: 0, marks: 0 },
    y:           { mt: 0, marks: 0 },
    fg:          { mt: 0, marks: 0 },
  };
  const LABEL: Record<string, string> = {
    notStarted: "Not Started", ts: "TS", galvanising: "Galvanising", y: "Y", fg: "Finished Goods",
  };
  let total = 0, totalMarks = 0;

  for (const r of rows) {
    if (r.category === "TLT") continue;
    const wMt = (r.balanceWt ?? 0) / 1000;
    total += wMt;
    totalMarks++;
    const stage = classifyNtltStage({
      activity: r.activity,
      jobCardType: r.jobCardType,
      jobCardStatus: r.jobCardStatus,
      contractor: r.contractor,
    });
    stages[stage].mt += wMt;
    stages[stage].marks++;
  }

  const stageSum = Object.values(stages).reduce((s, b) => s + b.mt, 0);
  const pass = Math.abs(total - stageSum) < 0.001;

  console.log(`\n━━━ DC16 NTLT five-stage — ${date} ━━━`);
  for (const [key, b] of Object.entries(stages)) {
    console.log(`  ${LABEL[key].padEnd(22)} ${fmt(b.mt)} MT  ${fmtN(b.marks)} marks`);
  }
  console.log(`  ${"TOTAL".padEnd(22)} ${fmt(total)} MT  ${fmtN(totalMarks)} marks`);
  console.log(`  Stage sum diff:       ${(total - stageSum).toFixed(3)}   → ${pass ? "✅ PASS" : "❌ FAIL"}`);
}

// ─── DC17 — WIP vs OR gap analysis ───────────────────────────────────────────

function dc17(
  wipRows: ReturnType<typeof parseWorkbook>["rows"],
  orRows: ReturnType<typeof parseOrderReview>["rows"],
  date: string,
) {
  // WIP balance per (project, structure) — TLT only
  const wipMap = new Map<string, number>();
  const wipProjects = new Set<string>();
  for (const r of wipRows) {
    if (r.category !== "TLT") continue;
    const key = `${r.job}\x01${r.structure}`;
    wipMap.set(key, (wipMap.get(key) ?? 0) + (r.balanceWt ?? 0) / 1000);
    if (r.job) wipProjects.add(r.job);
  }

  // OR quantities — scoped to active WIP projects only (mirrors live dataCheck.ts)
  const orMap = new Map<string, { j: number; q: number }>();
  for (const r of orRows) {
    if (!wipProjects.has(r.project)) continue;
    const key = `${r.project}\x01${r.structure}`;
    const ex = orMap.get(key) ?? { j: 0, q: 0 };
    ex.j += r.woOrderQtyMt  ?? 0;
    ex.q += r.fileDespatchMt ?? 0;
    orMap.set(key, ex);
  }

  // Union of both key sets — same as live app
  const allKeys = new Set([...orMap.keys(), ...wipMap.keys()]);
  const cats: Record<string, { count: number; mt: number }> = {};
  for (const c of ["A","B","C","D","E","F","G"]) cats[c] = { count: 0, mt: 0 };
  let flagged = 0;

  for (const key of allKeys) {
    const j   = orMap.get(key)?.j ?? 0;
    const q   = orMap.get(key)?.q ?? 0;
    const w   = wipMap.get(key) ?? 0;
    const cat = classifyDc17(j, q, w);
    if (cat === null) continue; // within tolerance
    const gap = j - q - w;
    cats[cat].count++;
    cats[cat].mt += gap;
    flagged++;
  }

  const CAT_LABELS: Record<string, string> = {
    A: "A  W=0 Q=0  never in production",
    B: "B  W=0 Q>0  left WIP, no despatch record",
    C: "C  W>0 Q=0  in production, WIP short of work order",
    D: "D  W>0 Q>0  partly shipped, WIP short of remainder",
    E: "E  J=0      marks in WIP with no work order",
    F: "F  |J−Q|≤0.05  despatched per OR, WIP still pending",
    G: "G  else     shop holds more than order book expects",
  };

  console.log(`\n━━━ DC17 WIP vs OR gap — ${date} ━━━`);
  console.log(`  Compared structures: ${allKeys.size}   Flagged: ${flagged}`);
  for (const [cat, info] of Object.entries(cats)) {
    if (info.count === 0) continue;
    console.log(`  ${CAT_LABELS[cat].padEnd(48)} count=${String(info.count).padStart(4)}  gap=${info.mt.toFixed(3).padStart(10)} MT`);
  }
  console.log(`  WIP TLT projects: ${wipProjects.size}   OR structures scoped to WIP projects`);
}

// ─── DC12-14 — cross-import mark movement ────────────────────────────────────

function dc1214(
  prevRows: ReturnType<typeof parseWorkbook>["rows"],
  currRows: ReturnType<typeof parseWorkbook>["rows"],
  prevDate: string,
  currDate: string,
) {
  type State = { rank: number; label: string; wt: number };
  const prevMap = new Map<string, State>();
  const currMap = new Map<string, State>();

  const labelOf = (r: (typeof prevRows)[number]) => {
    if ((r.jobCardType ?? "").trim().toLowerCase() === "fg pending for dispatch") return "FG";
    return (r.activity ?? "").trim().toUpperCase() || "?";
  };

  for (const r of prevRows) {
    const key = (r.markId ?? "") + "\x01" + (r.jobCardNo ?? "");
    const wt = r.balanceWt ?? 0;
    const ex = prevMap.get(key);
    if (!ex || wt > ex.wt) prevMap.set(key, { rank: actRank(r.activity, r.jobCardType), label: labelOf(r), wt });
  }
  for (const r of currRows) {
    const key = (r.markId ?? "") + "\x01" + (r.jobCardNo ?? "");
    const wt = r.balanceWt ?? 0;
    const ex = currMap.get(key);
    if (!ex || wt > ex.wt) currMap.set(key, { rank: actRank(r.activity, r.jobCardType), label: labelOf(r), wt });
  }

  let backward = 0, backWt = 0;
  let leavingFg = 0, leavingFgWt = 0;
  let vanished = 0, vanishedWt = 0;
  const backTrans = new Map<string, { count: number; wt: number }>();
  const vanishedActs = new Map<string, { count: number; wt: number }>();
  const fgTrans = new Map<string, { count: number; wt: number }>();

  for (const [key, prev] of prevMap) {
    const curr = currMap.get(key);
    if (!curr) {
      if (prev.rank >= 0 && prev.rank < FG_RANK) {
        vanished++; vanishedWt += prev.wt;
        const ex = vanishedActs.get(prev.label) ?? { count: 0, wt: 0 };
        vanishedActs.set(prev.label, { count: ex.count + 1, wt: ex.wt + prev.wt });
      }
      continue;
    }
    if (prev.rank < 0 || curr.rank < 0) continue;
    if (curr.rank < prev.rank) {
      backward++; backWt += prev.wt;
      const tk = `${prev.label}→${curr.label}`;
      const ex = backTrans.get(tk) ?? { count: 0, wt: 0 };
      backTrans.set(tk, { count: ex.count + 1, wt: ex.wt + prev.wt });
      if (prev.rank === FG_RANK) {
        leavingFg++; leavingFgWt += prev.wt;
        const exFg = fgTrans.get(tk) ?? { count: 0, wt: 0 };
        fgTrans.set(tk, { count: exFg.count + 1, wt: exFg.wt + prev.wt });
      }
    }
  }

  const top = (m: Map<string, { count: number; wt: number }>, n = 8) =>
    [...m.entries()].sort((a, b) => b[1].wt - a[1].wt).slice(0, n);

  console.log(`\n━━━ DC12-14 ${prevDate} → ${currDate} ━━━`);
  console.log(`  DC12 backward:      ${String(backward).padStart(5)} marks  ${(backWt/1000).toFixed(3)} MT`);
  for (const [t, v] of top(backTrans)) {
    console.log(`        ${t.padEnd(12)} ${String(v.count).padStart(5)} marks  ${(v.wt/1000).toFixed(3)} MT`);
  }
  console.log(`  DC13 leaving FG:    ${String(leavingFg).padStart(5)} marks  ${(leavingFgWt/1000).toFixed(3)} MT`);
  for (const [t, v] of top(fgTrans)) {
    console.log(`        ${t.padEnd(12)} ${String(v.count).padStart(5)} marks  ${(v.wt/1000).toFixed(3)} MT`);
  }
  console.log(`  DC14 vanished(<FG): ${String(vanished).padStart(5)} marks  ${(vanishedWt/1000).toFixed(3)} MT`);
  for (const [act, v] of top(vanishedActs)) {
    console.log(`        from ${act.padEnd(6)} ${String(v.count).padStart(5)} marks  ${(v.wt/1000).toFixed(3)} MT`);
  }
}

// ─── Summary: OR vs production ────────────────────────────────────────────────

function orSummary(orResult: ReturnType<typeof parseOrderReview>, date: string) {
  const r = orResult;
  console.log(`\n━━━ OR parse — ${date} ━━━`);
  console.log(`  asOnDate: ${r.asOnDate ?? "(not found)"}`);
  console.log(`  Raw rows: ${r.rows.length}`);
  const projects = new Set(r.rows.map(row => row.project));
  const structures = new Set(r.rows.map(row => `${row.project}\x01${row.structure}`));
  console.log(`  Projects: ${projects.size}   Structures: ${structures.size}`);
  const totalWoQty = r.rows.reduce((s, row) => s + (row.woOrderQtyMt ?? 0), 0);
  const totalDesp  = r.rows.reduce((s, row) => s + (row.fileDespatchMt ?? 0), 0);
  const totalRel   = r.rows.reduce((s, row) => s + (row.releaseMt ?? 0), 0);
  console.log(`  WO Order Qty (J): ${totalWoQty.toFixed(3)} MT`);
  console.log(`  Progress Release (L): ${totalRel.toFixed(3)} MT`);
  console.log(`  Progress Despatch (Q): ${totalDesp.toFixed(3)} MT`);
}

// ─── WIP summary ─────────────────────────────────────────────────────────────

function wipSummary(result: ReturnType<typeof parseWorkbook>, date: string) {
  const totalRows = result.rows.length;
  const totalMt = result.rows.reduce((s, r) => s + (r.balanceWt ?? 0) / 1000, 0);
  const tlt = result.rows.filter(r => r.category === "TLT");
  const ntlt = result.rows.filter(r => r.category !== "TLT");
  console.log(`\n━━━ WIP parse — ${date} ━━━`);
  console.log(`  Total rows: ${totalRows}   Total MT: ${totalMt.toFixed(3)}`);
  console.log(`  TLT: ${tlt.length} rows  ${tlt.reduce((s,r)=>s+(r.balanceWt??0)/1000,0).toFixed(3)} MT`);
  console.log(`  NTLT: ${ntlt.length} rows  ${ntlt.reduce((s,r)=>s+(r.balanceWt??0)/1000,0).toFixed(3)} MT`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const parsed: { date: string; wip: ReturnType<typeof parseWorkbook>; or: ReturnType<typeof parseOrderReview> }[] = [];

  for (const f of FILES) {
    const wipBuf = fs.readFileSync(path.join(ROOT, f.wip));
    const orBuf  = fs.readFileSync(path.join(ROOT, f.or));
    const wip = parseWorkbook(wipBuf);
    const or  = parseOrderReview(orBuf);
    parsed.push({ date: f.date, wip, or });
    wipSummary(wip, f.date);
    orSummary(or, f.date);
  }

  // DC6 + DC16 per date
  for (const p of parsed) {
    dc6(p.wip.rows, p.date);
    dc16(p.wip.rows, p.date);
  }

  // DC17 per date
  for (const p of parsed) {
    dc17(p.wip.rows, p.or.rows, p.date);
  }

  // DC12-14 between consecutive dates
  dc1214(parsed[0].wip.rows, parsed[1].wip.rows, parsed[0].date, parsed[1].date);
  dc1214(parsed[1].wip.rows, parsed[2].wip.rows, parsed[1].date, parsed[2].date);

  console.log("\n✅ Verification complete.\n");
}

main().catch(err => { console.error(err); process.exit(1); });
