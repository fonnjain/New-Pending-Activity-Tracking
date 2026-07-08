import { useMemo, useState } from "react";
import {
  useListContractorCategories,
  useUpsertContractorCategory,
  useDeleteContractorCategory,
  useGetImportRecords,
  getListContractorCategoriesQueryKey,
  getGetImportRecordsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useTracker } from "@/lib/store";
import {
  CONTRACTOR_CATEGORIES,
  OUT_VENDOR_TYPES,
  PLANT_LOCATION_OPTIONS,
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
import { Users, Trash2, Search, FileSpreadsheet, Plus } from "lucide-react";

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
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Users className="w-5 h-5 text-muted-foreground" />
          <h1 className="text-xl font-bold tracking-tight">Contractor Setup</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            disabled={filtered.length === 0}
          >
            <FileSpreadsheet className="w-4 h-4 mr-1.5" />
            Export Excel
          </Button>
          <LogoutButton />
        </div>
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
                  onValueChange={(v) => setAddCategory(v as ContractorCategory)}
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
                    {PLANT_LOCATION_OPTIONS.map((o) => (
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
                          onValueChange={(v) =>
                            save(r.displayName, v as ContractorCategory, r.outVendorType, r.plantLocation)
                          }
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
                            {PLANT_LOCATION_OPTIONS.map((o) => (
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
