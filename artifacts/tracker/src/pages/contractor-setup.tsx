import { useMemo, useState } from "react";
import {
  useListContractorCategories,
  useUpsertContractorCategory,
  useDeleteContractorCategory,
  useGetImportRecords,
  useListContractorAliases,
  useListContractorDedupProposals,
  useAnalyzeContractorDedup,
  useApproveContractorDedupProposal,
  useRejectContractorDedupProposal,
  useDeleteContractorAlias,
  getListContractorCategoriesQueryKey,
  getGetImportRecordsQueryKey,
  getListContractorAliasesQueryKey,
  getListContractorDedupProposalsQueryKey,
  getGetContractorDedupPendingCountQueryKey,
  type ContractorDedupProposal,
  type ContractorAlias,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useTracker } from "@/lib/store";
import {
  CONTRACTOR_CATEGORIES,
  OUT_VENDOR_TYPES,
  PLANT_LOCATION_OPTIONS,
  plantLocationOptionsFor,
  isOutVendorOnlyLocation,
  normalizeContractorName,
  plantLocationLabel,
  type ContractorCategory,
  type OutVendorType,
  type PlantLocation,
} from "@workspace/domain";
import { LoginGate, LogoutButton } from "@/components/login-gate";
import { exportToXlsx, type XlsxColumn } from "@/lib/export";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Users, Trash2, Search, FileSpreadsheet, Plus, Sparkles, CheckCircle2, XCircle, ChevronDown, ChevronRight, Link2Off } from "lucide-react";

interface RowState {
  displayName: string;
  category: ContractorCategory;
  outVendorType: OutVendorType[];
  plantLocation: PlantLocation | null;
  mapped: boolean;
}

export default function ContractorSetupView() {
  return (
    <LoginGate>
      <ContractorSetupContent />
    </LoginGate>
  );
}

export function ContractorSetupContent() {
  const [activeTab, setActiveTab] = useState<"contractors" | "dedup">("contractors");
  const { data: pendingProposals } = useListContractorDedupProposals({ status: "pending" });
  const pendingCount = pendingProposals?.length ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Users className="w-5 h-5 text-muted-foreground" />
          <h1 className="text-xl font-bold tracking-tight">Contractor Setup</h1>
          {pendingCount > 0 && (
            <span className="inline-flex items-center justify-center rounded-full bg-amber-500 text-white text-xs font-bold px-2 py-0.5 min-w-[22px]">
              {pendingCount}
            </span>
          )}
        </div>
        <LogoutButton />
      </div>

      <Segmented
        value={activeTab}
        onChange={(v) => setActiveTab(v as "contractors" | "dedup")}
        options={[
          { value: "contractors", label: "Contractors" },
          {
            value: "dedup",
            label: pendingCount > 0 ? `Dedup (${pendingCount} pending)` : "Dedup",
          },
        ]}
      />

      {activeTab === "contractors" ? (
        <ContractorSetupInner />
      ) : (
        <ContractorDedupTab />
      )}
    </div>
  );
}

// ============================================================================
// Dedup Tab
// ============================================================================

function ConfidenceBadge({ confidence }: { confidence: number | null | undefined }) {
  if (confidence == null) return null;
  const pct = Math.round(confidence * 100);
  const color =
    pct >= 90 ? "bg-green-100 text-green-800" :
    pct >= 70 ? "bg-yellow-100 text-yellow-800" :
    "bg-red-100 text-red-800";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>
      {pct}% confidence
    </span>
  );
}

function ProposalCard({
  proposal,
  onApprove,
  onReject,
  isApproving,
  isRejecting,
  approveError,
}: {
  proposal: ContractorDedupProposal;
  onApprove: () => void;
  onReject: () => void;
  isApproving: boolean;
  isRejecting: boolean;
  approveError?: string | null;
}) {
  const [showEntries, setShowEntries] = useState(true);
  const entries = (proposal.aliasEntries ?? []) as { rawName: string; normalizedKey: string }[];

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-sm">{proposal.canonicalDisplay}</span>
              <span className="text-xs text-muted-foreground font-mono">{proposal.canonicalKey}</span>
              <ConfidenceBadge confidence={proposal.confidence} />
              {proposal.confidence == null && (
                <span className="inline-flex items-center rounded-full bg-blue-100 text-blue-800 px-2 py-0.5 text-xs font-medium">
                  New contractor
                </span>
              )}
            </div>
            {proposal.reason && (
              <p className="text-xs text-muted-foreground italic">{proposal.reason}</p>
            )}
          </div>
          {proposal.status === "pending" && (
            <div className="flex items-center gap-2 shrink-0">
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-green-700 border-green-300 hover:bg-green-50"
                onClick={onApprove}
                disabled={isApproving || isRejecting}
              >
                <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-red-700 border-red-300 hover:bg-red-50"
                onClick={onReject}
                disabled={isApproving || isRejecting}
              >
                <XCircle className="w-3.5 h-3.5 mr-1" />
                Reject
              </Button>
            </div>
          )}
          {proposal.status === "approved" && (
            <span className="text-xs font-medium text-green-700 bg-green-100 rounded-full px-2 py-0.5 shrink-0">Approved</span>
          )}
          {proposal.status === "rejected" && (
            <span className="text-xs font-medium text-red-700 bg-red-100 rounded-full px-2 py-0.5 shrink-0">Rejected</span>
          )}
        </div>

        {entries.length > 0 && (
          <div>
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-1"
              onClick={() => setShowEntries((s) => !s)}
            >
              {showEntries ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              {entries.length} alias{entries.length !== 1 ? "es" : ""} will be merged under canonical
            </button>
            {showEntries && (
              <ul className="ml-4 space-y-0.5">
                {entries.map((e, i) => (
                  <li key={i} className="text-xs text-muted-foreground flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 shrink-0" />
                    <span>{e.rawName}</span>
                    <span className="font-mono opacity-60">{e.normalizedKey}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {approveError && (
          <p className="text-xs text-destructive bg-destructive/10 rounded px-2 py-1">
            {approveError}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ContractorDedupTab() {
  const queryClient = useQueryClient();

  const { data: allProposals, isLoading: proposalsLoading } = useListContractorDedupProposals();
  const { data: aliases, isLoading: aliasesLoading } = useListContractorAliases();

  const analyze = useAnalyzeContractorDedup();
  const approve = useApproveContractorDedupProposal();
  const reject = useRejectContractorDedupProposal();
  const deleteAlias = useDeleteContractorAlias();

  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [analyzeMessage, setAnalyzeMessage] = useState<string | null>(null);
  const [showReviewed, setShowReviewed] = useState(false);
  const [approveErrors, setApproveErrors] = useState<Record<number, string>>({});

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: getListContractorDedupProposalsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetContractorDedupPendingCountQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListContractorAliasesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListContractorCategoriesQueryKey() });
  };

  const handleAnalyze = () => {
    setAnalyzeError(null);
    setAnalyzeMessage(null);
    analyze.mutate(undefined, {
      onSuccess: (data) => {
        setAnalyzeMessage(
          data.proposals.length === 0
            ? (data.message ?? "No new merge groups found.")
            : `${data.proposals.length} new proposal${data.proposals.length !== 1 ? "s" : ""} created.`,
        );
        invalidateAll();
      },
      onError: (e) => {
        setAnalyzeError(`Analysis failed: ${e.message ?? String(e)}`);
      },
    });
  };

  const handleApprove = (id: number) => {
    setApproveErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    approve.mutate({ id }, {
      onSuccess: invalidateAll,
      onError: (e) => {
        const msg = (e as { response?: { data?: { error?: string } }; message?: string })
          ?.response?.data?.error ?? e.message ?? String(e);
        setApproveErrors((prev) => ({ ...prev, [id]: msg }));
      },
    });
  };

  const handleReject = (id: number) => {
    reject.mutate({ id }, {
      onSuccess: invalidateAll,
    });
  };

  const handleDeleteAlias = (aliasKey: string) => {
    deleteAlias.mutate(
      { params: { aliasKey } },
      { onSuccess: invalidateAll },
    );
  };

  const pending = allProposals?.filter((p) => p.status === "pending") ?? [];
  const reviewed = allProposals?.filter((p) => p.status !== "pending") ?? [];

  return (
    <div className="space-y-6">
      {/* Analyze Section */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">
            AI Analysis
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Run an AI pass over all contractor names in the system to find likely duplicates
            (punctuation variants, spacing differences). The AI proposes merge groups; you
            approve or reject each one. No changes are made without your approval.
          </p>
          <div className="flex items-center gap-3">
            <Button
              onClick={handleAnalyze}
              disabled={analyze.isPending}
              className="gap-2"
            >
              <Sparkles className="w-4 h-4" />
              {analyze.isPending ? "Analyzing…" : "Analyze Contractors"}
            </Button>
          </div>
          {analyzeError && (
            <p className="text-sm text-destructive">{analyzeError}</p>
          )}
          {analyzeMessage && (
            <p className="text-sm text-green-700 dark:text-green-400">{analyzeMessage}</p>
          )}
        </CardContent>
      </Card>

      {/* Pending Proposals */}
      <div className="space-y-3">
        <h2 className="text-base font-semibold">
          Pending Review
          {pending.length > 0 && (
            <span className="ml-2 inline-flex items-center justify-center rounded-full bg-amber-500 text-white text-xs font-bold px-2 py-0.5 min-w-[22px]">
              {pending.length}
            </span>
          )}
        </h2>
        {proposalsLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : pending.length === 0 ? (
          <div className="text-sm text-muted-foreground border rounded-lg p-6 text-center">
            No pending proposals. Run AI Analysis above, or upload a WIP file to flag new contractors.
          </div>
        ) : (
          pending.map((p) => (
            <ProposalCard
              key={p.id}
              proposal={p}
              onApprove={() => handleApprove(p.id)}
              onReject={() => handleReject(p.id)}
              isApproving={approve.isPending}
              isRejecting={reject.isPending}
              approveError={approveErrors[p.id]}
            />
          ))
        )}
      </div>

      {/* Reviewed Proposals (collapsible) */}
      {reviewed.length > 0 && (
        <div className="space-y-3">
          <button
            type="button"
            className="flex items-center gap-2 text-sm font-semibold text-muted-foreground hover:text-foreground"
            onClick={() => setShowReviewed((s) => !s)}
          >
            {showReviewed ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            Reviewed ({reviewed.length})
          </button>
          {showReviewed &&
            reviewed.map((p) => (
              <ProposalCard
                key={p.id}
                proposal={p}
                onApprove={() => {}}
                onReject={() => {}}
                isApproving={false}
                isRejecting={false}
              />
            ))}
        </div>
      )}

      {/* Active Alias Mappings */}
      <div className="space-y-3">
        <h2 className="text-base font-semibold">Active Alias Mappings</h2>
        <p className="text-xs text-muted-foreground">
          These aliases were created when a proposal was approved. Alias contractor names
          are silently resolved to their canonical on every page. Removing an alias does
          not restore the original contractor_categories row.
        </p>
        {aliasesLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : !aliases || aliases.length === 0 ? (
          <div className="text-sm text-muted-foreground border rounded-lg p-6 text-center">
            No active aliases. Approve a merge proposal to create aliases.
          </div>
        ) : (
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Alias (raw name)</TableHead>
                    <TableHead>Alias Key (normalized)</TableHead>
                    <TableHead>Canonical Key</TableHead>
                    <TableHead className="w-[60px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {aliases.map((a) => (
                    <TableRow key={a.aliasKey}>
                      <TableCell className="font-medium text-sm">{a.rawName}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{a.aliasKey}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{a.canonicalKey}</TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                          onClick={() => handleDeleteAlias(a.aliasKey)}
                          disabled={deleteAlias.isPending}
                          title="Remove alias"
                        >
                          <Link2Off className="w-4 h-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Original contractors tab (moved into its own component)
// ============================================================================

function ContractorSetupInner() {
  const { selectedImportId } = useTracker();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");

  // "Add Contractor" form state
  const [addName, setAddName] = useState("");
  const [addCategory, setAddCategory] = useState<ContractorCategory>("UNCLASSIFIED");
  const [addPlantLocation, setAddPlantLocation] = useState<PlantLocation | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const { data: mappings } = useListContractorCategories({
    query: { queryKey: getListContractorCategoriesQueryKey() },
  });
  const { data: allRecords } = useGetImportRecords(selectedImportId as number, {
    query: {
      enabled: !!selectedImportId,
      queryKey: getGetImportRecordsQueryKey(selectedImportId as number),
    },
  });

  const upsert = useUpsertContractorCategory();
  const del = useDeleteContractorCategory();

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: getListContractorCategoriesQueryKey(),
    });

  // Union of every contractor seen in the current import and every contractor
  // that already has a saved mapping (so seeded out-vendors show even when the
  // current import has no rows for them). Keyed by the normalized name.
  const rows = useMemo(() => {
    const byKey = new Map<string, RowState>();
    for (const r of allRecords ?? []) {
      const name = r.contractor?.trim();
      if (!name) continue;
      const key = normalizeContractorName(name);
      if (!byKey.has(key)) {
        byKey.set(key, {
          displayName: name,
          category: "UNCLASSIFIED",
          outVendorType: [],
          plantLocation: null,
          mapped: false,
        });
      }
    }
    for (const m of mappings ?? []) {
      byKey.set(m.nameKey, {
        displayName: m.displayName,
        category: m.category as ContractorCategory,
        outVendorType: (m.outVendorType ?? []) as OutVendorType[],
        plantLocation: (m.plantLocation as PlantLocation | null) ?? null,
        mapped: true,
      });
    }
    return Array.from(byKey.entries())
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [allRecords, mappings]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.displayName.toLowerCase().includes(q));
  }, [rows, search]);

  const save = (
    displayName: string,
    category: ContractorCategory,
    outVendorType: OutVendorType[],
    plantLocation: PlantLocation | null,
  ) => {
    upsert.mutate(
      {
        data: {
          displayName,
          category,
          outVendorType,
          plantLocation: plantLocation ?? null,
        },
      },
      { onSuccess: invalidate },
    );
  };

  const remove = (key: string) => {
    del.mutate({ params: { nameKey: key } }, { onSuccess: invalidate });
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) c[r.category] = (c[r.category] ?? 0) + 1;
    return c;
  }, [rows]);

  const categoryLabel = (v: ContractorCategory) =>
    CONTRACTOR_CATEGORIES.find((c) => c.value === v)?.label ?? v;
  const outVendorLabel = (v: OutVendorType) =>
    OUT_VENDOR_TYPES.find((t) => t.value === v)?.label ?? v;

  const handleExport = () => {
    const columns: XlsxColumn[] = [
      { label: "Contractor", field: "contractor" },
      { label: "Type", field: "type" },
      { label: "Tags", field: "outVendorTags" },
      { label: "Plant Location", field: "plantLocation" },
    ];
    const exportRows = filtered.map((r) => ({
      contractor: r.displayName,
      type: categoryLabel(r.category),
      outVendorTags:
        r.outVendorType.length
          ? r.outVendorType.map(outVendorLabel).join(", ")
          : "-",
      plantLocation: plantLocationLabel(r.plantLocation),
    }));
    exportToXlsx("contractor-setup.xlsx", columns, exportRows, {
      sheetName: "Contractor Setup",
    });
  };

  const handleAdd = () => {
    const name = addName.trim();
    if (!name) {
      setAddError("Contractor name is required.");
      return;
    }
    const key = normalizeContractorName(name);
    const existing = rows.find((r) => r.key === key);
    if (existing) {
      setAddError(
        `"${existing.displayName}" already exists. Edit it in the table below.`,
      );
      return;
    }
    save(name, addCategory, [], addPlantLocation);
    setAddName("");
    setAddCategory("UNCLASSIFIED");
    setAddPlantLocation(null);
    setAddError(null);
    setAddOpen(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={handleExport}
          disabled={filtered.length === 0}
        >
          <FileSpreadsheet className="w-4 h-4 mr-1.5" />
          Export Excel
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">
        Classify each contractor as CNC, Sub-contractor, or Out-vendor.
        Any contractor can be tagged Fabrication and/or Galvanizing and assigned a Plant Location.
        Mappings are descriptive only — they never change parsing, ageing, quantities, or the
        contractor names themselves, and are matched on the full contractor name.
      </p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {CONTRACTOR_CATEGORIES.map((c) => (
          <Card key={c.value}>
            <CardContent className="p-4">
              <div className="text-2xl font-bold tabular-nums">
                {counts[c.value] ?? 0}
              </div>
              <div className="text-xs text-muted-foreground uppercase tracking-wider">
                {c.label}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Add Contractor */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">
              Add Contractor
            </CardTitle>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setAddOpen((o) => !o);
                setAddError(null);
              }}
            >
              <Plus className="w-4 h-4 mr-1.5" />
              {addOpen ? "Cancel" : "Add"}
            </Button>
          </div>
        </CardHeader>
        {addOpen && (
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-1">
                <label className="text-xs font-semibold text-muted-foreground uppercase mb-1 block">
                  Contractor Name
                </label>
                <Input
                  value={addName}
                  onChange={(e) => {
                    setAddName(e.target.value);
                    setAddError(null);
                  }}
                  placeholder="Enter contractor name..."
                  onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase mb-1 block">
                  Type
                </label>
                <Select
                  value={addCategory}
                  onValueChange={(v) => {
                    const next = v as ContractorCategory;
                    setAddCategory(next);
                    // If current plant location is Out-vendor-only but type is changing
                    // away from Out-vendor, reset to Unassigned.
                    if (next !== "OUT_VENDOR" && isOutVendorOnlyLocation(addPlantLocation)) {
                      setAddPlantLocation(null);
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CONTRACTOR_CATEGORIES.map((c) => (
                      <SelectItem key={c.value} value={c.value}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase mb-1 block">
                  Plant Location
                  {addCategory === "OUT_VENDOR" && (
                    <span className="ml-1 font-normal normal-case text-muted-foreground/70">
                      (Out-vendor options)
                    </span>
                  )}
                </label>
                <Select
                  value={addPlantLocation ?? "__unassigned__"}
                  onValueChange={(v) =>
                    setAddPlantLocation(v === "__unassigned__" ? null : (v as PlantLocation))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {plantLocationOptionsFor(addCategory).map((o) => (
                      <SelectItem
                        key={o.value ?? "__unassigned__"}
                        value={o.value ?? "__unassigned__"}
                      >
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {addError && (
              <p className="text-sm text-destructive">{addError}</p>
            )}
            <Button size="sm" onClick={handleAdd} disabled={upsert.isPending}>
              <Plus className="w-4 h-4 mr-1.5" />
              Add Contractor
            </Button>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">
            Contractors
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search contractors..."
              className="pl-9"
            />
          </div>

          {filtered.length === 0 ? (
            <div className="text-center p-8 text-muted-foreground text-sm">
              {rows.length === 0
                ? "No contractors found. Upload an import to populate the list, or use Add Contractor above."
                : "No contractors match your search."}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Contractor</TableHead>
                    <TableHead className="w-[180px]">Type</TableHead>
                    <TableHead className="w-[220px]">Tags</TableHead>
                    <TableHead className="w-[180px]">Plant Location</TableHead>
                    <TableHead className="w-[60px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((r) => (
                    <TableRow key={r.key}>
                      <TableCell className="font-medium text-sm">
                        {r.displayName}
                      </TableCell>
                      <TableCell>
                        <Select
                          value={r.category}
                          onValueChange={(v) => {
                            const newCat = v as ContractorCategory;
                            // If the current plant location is Out-vendor-only and the type
                            // is changing away from Out-vendor, reset to Unassigned so we
                            // never leave an orphaned value.
                            const plantLoc =
                              newCat !== "OUT_VENDOR" && isOutVendorOnlyLocation(r.plantLocation)
                                ? null
                                : r.plantLocation;
                            save(r.displayName, newCat, r.outVendorType, plantLoc);
                          }}
                        >
                          <SelectTrigger className="h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {CONTRACTOR_CATEGORIES.map((c) => (
                              <SelectItem key={c.value} value={c.value}>
                                {c.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-4">
                          {OUT_VENDOR_TYPES.map((t) => {
                            const checked = r.outVendorType.includes(t.value);
                            return (
                              <label
                                key={t.value}
                                className="flex items-center gap-1.5 text-sm cursor-pointer"
                              >
                                <Checkbox
                                  checked={checked}
                                  onCheckedChange={(c) => {
                                    const next = c
                                      ? Array.from(new Set([...r.outVendorType, t.value]))
                                      : r.outVendorType.filter((x) => x !== t.value);
                                    save(r.displayName, r.category, next, r.plantLocation);
                                  }}
                                />
                                {t.label}
                              </label>
                            );
                          })}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={r.plantLocation ?? "__unassigned__"}
                          onValueChange={(v) =>
                            save(
                              r.displayName,
                              r.category,
                              r.outVendorType,
                              v === "__unassigned__" ? null : (v as PlantLocation),
                            )
                          }
                        >
                          <SelectTrigger className="h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {plantLocationOptionsFor(r.category).map((o) => (
                              <SelectItem
                                key={o.value ?? "__unassigned__"}
                                value={o.value ?? "__unassigned__"}
                              >
                                {o.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        {r.mapped && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                            onClick={() => remove(r.key)}
                            disabled={del.isPending}
                            title="Reset to Unclassified"
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
