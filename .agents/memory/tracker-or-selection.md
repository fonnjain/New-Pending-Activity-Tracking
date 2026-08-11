---
name: OR selection by as_on_date
description: loadLatestOrderReview and loadLatestWipImport must sort by date DESC, not id — bulk uploads assign higher ids to older-dated files. Predecessor queries must also use date-based WHERE, not id-based.
---

## Rule — latest import resolution
Both `loadLatestOrderReview()` and `loadLatestWipImport()` in `artifacts/api-server/src/lib/dispatch.ts` must order by:
```
reportDate/asOnDate DESC NULLS LAST, id DESC
```
Never by `id DESC` or `created_at DESC` alone.

**Why:** On 10-Aug-2026 the user bulk-uploaded all historical WIP and OR files. The DB assigned ids in upload order; older-dated files got higher ids. Sorting by id alone gave the wrong "latest". Concrete example: import 59 = 08-Aug, import 58 = 10-Aug — id order is inverted relative to date order.

**How to apply:** Every call site that needs "the current WIP state" must call `loadLatestWipImport()` from dispatch.ts. Every call site that needs "the current Order Review" must call `loadLatestOrderReview()`. Never build a raw `orderBy(desc(importsTable.id)).limit(1)` query for this purpose.

`loadLatestWipImport()` is now used in:
- dispatch.ts (seedDispatchFromOrderReview, loadNewestWipStructureKeys)
- routes: erpRules, releaseBalance, fabricationProjectCompletion, inventory, jobTemplates, dataCheck
- lib: currentJobs

## Rule — predecessor queries must use date-bounded WHERE, not id-bounded

Predecessor queries that find "the import before X" MUST use:
```typescript
.where(or(
  lt(importsTable.reportDate, current.reportDate),
  and(eq(importsTable.reportDate, current.reportDate), lt(importsTable.id, current.id)),
))
.orderBy(sql`${importsTable.reportDate} DESC NULLS LAST`, desc(importsTable.id))
```

**Why:** `WHERE id < target.id` is wrong when ids and dates are out of order. For target=58 (10-Aug), `id < 58` EXCLUDES import 59 (08-Aug, which is the true immediate predecessor), returning 57 (07-Aug) instead. Date-bounded WHERE correctly includes 59.

**Affected files (all fixed):** productionMovement.ts (×2), ai.ts (×2), imports.ts changes/movement/velocity routes (×5). The WHERE clause uses `or(lt(date), and(eq(date), lt(id)))` combined with any existing cutoffSql via `and()`.

## dataCheck.ts Promise.all destructuring hazard
`loadLatestWipImport()` returns `T | null` (not `T[]`). When used in `Promise.all`, do NOT do `const [[latestWip], orData] = await Promise.all([loadLatestWipImport(), ...])`. The outer `[0]` index tries to subscript an object. Use:
```typescript
const [latestWip, orData] = await Promise.all([loadLatestWipImport(), loadLatestOrderReview()]);
```

## Stale-date guard (OR uploads)
The commit route rejects a commit with 409 when the file's `as_on_date` < current newest OR's `as_on_date`. Returns `{ staleDateWarning: true, fileAsOnDate, existingAsOnDate }`. The upload panel intercepts this and shows an amber override banner with "Upload anyway" (posts `forceStaleDate: true`) instead of a generic error toast.

## Pages that now resolve to 10-Aug (58) vs formerly 08-Aug (59)
After the fix, all "auto-resolved latest WIP" features show import 58 (10-Aug) instead of import 59 (08-Aug). Affected:
- Release Balance, ERP Rules, Inventory Buckets, Job Templates projects list
- Current Jobs known-project list, Data Check WIP buckets
- Fabrication Project Completion, dispatch seed watermark, newest WIP structure keys

## 10-Aug regression baseline (import 58 WIP, import 53 OR)
Import summary TLT (importId=58): 10,723.709 MT total, 59,171 marks.
Project Wise (OR import 53 filtered to WIP-58 jobs):
- Work Order: 27,131.073 MT | Dispatch: 14,380.689 MT
- Dispatch Balance (WO − Dispatch): 12,750.384 MT
- FG (Order Review) = galv_mt − desp_mt: 4,618.594 MT
DC hard rules: DC1–DC2 pass, DC3 = 1 violation, DC4–DC6 pass.
DC soft warnings: DC7 = 49, DC8 = 227, DC9 = 20, DC10 = 2, DC15 = 0.

## DC7 tolerance
DC7 (`L > J`, release beyond WO) uses a 10 kg tolerance (0.010 MT).

## DC11 dropped
Derived N−O (galv − inspection) ≠ 0 was a normal condition. Col V (Balance Inspection) is not stored in the DB.

## Row count: file vs DB discrepancy
2038 OR rows in DB vs 2077 user-counted. Likely cause is the leading-dash strip the parser applies. Not a data-loss risk.
