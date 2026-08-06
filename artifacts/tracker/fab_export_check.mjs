import ExcelJS from "exceljs";
import { FAB_LOAD_SECTIONS, fabLoadColumnsForSection, activityRank, normalizeActivity, routeIncludesOp, classifyWipCase } from "@workspace/domain";

const recs = await (await fetch("http://localhost:8080/api/imports/38/records")).json();
const W = activityRank("W"), B = activityRank("B");
const isCutting = a => (a ?? "").trim().toUpperCase() === "C";

function match(section, column, r) {
  const cls = classifyWipCase(r);
  const notReleased = cls === "NOT_RELEASED";
  if (section === "upcoming") { if (!notReleased) return false; }
  else if (isCutting(r.activity) && cls !== "CUTTING" && cls !== "AWAITING_ASSIGNMENT") return false;
  const act = normalizeActivity(r.activity), rank = activityRank(r.activity);
  const sec = r.sectionType, op = r.holeOperation;
  if (section === "operational") {
    switch (column) {
      case "welded": return act === "W";
      case "bending": return act === "B";
      case "anglePunch": return sec==="ANGLE" && act==="RFI" && op==="PUNCHING";
      case "drilling": return sec==="ANGLE" && act==="RFI" && op==="DRILLING";
      case "platePunch": return sec==="PLATE" && act==="RFI" && op==="PUNCHING";
      case "plateDrill": return sec==="PLATE" && act==="RFI" && op==="DRILLING";
    }
  }
  switch (column) {
    case "welded": return rank < W && routeIncludesOp(r.operation, "W");
    case "bending": return rank < B && routeIncludesOp(r.operation, "B");
    case "anglePunch": return sec==="ANGLE" && act==="C" && op==="PUNCHING";
    case "drilling": return sec==="ANGLE" && act==="C" && op==="DRILLING";
    case "platePunch": return sec==="PLATE" && act==="C" && op==="PUNCHING";
    case "plateDrill": return sec==="PLATE" && act==="C" && op==="DRILLING";
  }
  return false;
}

const tlt = recs.filter(r => (r.category || "TLT") === "TLT" && (r.job||"").trim() && r.job !== "(Unassigned)" && (r.balanceWt ?? 0) > 0);
// sanity: upcoming universe
const up = tlt.filter(r => classifyWipCase(r) === "NOT_RELEASED");
console.log("TLT records:", tlt.length, "| NOT_RELEASED marks:", up.length, "| NOT_RELEASED MT:", (up.reduce((s,r)=>s+r.balanceWt,0)/1000).toFixed(3));

const wb = new ExcelJS.Workbook();
for (const s of FAB_LOAD_SECTIONS) {
  const ws = wb.addWorksheet(s.label);
  const cols = fabLoadColumnsForSection(s.value);
  let colIdx = 1;
  const sums = [];
  for (const c of cols) {
    const per = new Map();
    for (const r of tlt) if (match(s.value, c.value, r)) per.set(r.job, (per.get(r.job)??0)+r.balanceWt);
    const rows = [...per.entries()].map(([p,kg])=>[p, Math.round(kg)/1000]).sort((a,b)=>b[1]-a[1]);
    const total = rows.reduce((x,r)=>x+r[1],0);
    sums.push(`${c.label}=${total.toFixed(3)}`);
    ws.getCell(1, colIdx).value = c.label; ws.getCell(1, colIdx).font = { bold: true };
    ws.getCell(2, colIdx).value = "Project"; ws.getCell(2, colIdx+1).value = "Wt (t)";
    rows.forEach((r,i)=>{ ws.getCell(3+i, colIdx).value = r[0]; ws.getCell(3+i, colIdx+1).value = Math.round(r[1]*1000)/1000; });
    ws.getCell(3+rows.length, colIdx).value = "G. Total"; ws.getCell(3+rows.length, colIdx+1).value = Math.round(total*1000)/1000;
    ws.getCell(3+rows.length, colIdx).font = { bold: true }; ws.getCell(3+rows.length, colIdx+1).font = { bold: true };
    colIdx += 3;
  }
  console.log(s.label, "→", sums.join("  "));
}
await wb.xlsx.writeFile("/home/runner/workspace/attached_assets/generated/fabrication_load_tlt_sample_export.xlsx");
console.log("written");
