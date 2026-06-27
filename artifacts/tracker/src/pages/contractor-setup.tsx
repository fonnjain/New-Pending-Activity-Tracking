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
  normalizeContractorName,
  type ContractorCategory,
  type OutVendorType,
} from "@workspace/domain";
import { LoginGate, LogoutButton } from "@/components/login-gate";
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
import { Users, Trash2, Search } from "lucide-react";

interface RowState {
  displayName: string;
  category: ContractorCategory;
  outVendorType: OutVendorType[];
  mapped: boolean; // has a saved overlay row
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
          mapped: false,
        });
      }
    }
    for (const m of mappings ?? []) {
      byKey.set(m.nameKey, {
        displayName: m.displayName,
        category: m.category as ContractorCategory,
        outVendorType: (m.outVendorType ?? []) as OutVendorType[],
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
  ) => {
    upsert.mutate(
      {
        data: {
          displayName,
          category,
          outVendorType: category === "OUT_VENDOR" ? outVendorType : [],
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Users className="w-5 h-5 text-muted-foreground" />
          <h1 className="text-xl font-bold tracking-tight">Contractor Setup</h1>
        </div>
        <LogoutButton />
      </div>

      <p className="text-sm text-muted-foreground">
        Classify each contractor as In-house, Sub-contractor, or Out-vendor.
        Out-vendors can be tagged Fabrication and/or Galvanizing. Mappings are
        descriptive only — they never change parsing, ageing, quantities, or the
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
                ? "No contractors found. Upload an import to populate the list, or out-vendor mappings will appear once seeded."
                : "No contractors match your search."}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Contractor</TableHead>
                    <TableHead className="w-[200px]">Type</TableHead>
                    <TableHead className="w-[220px]">Out-vendor Tags</TableHead>
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
                            save(r.displayName, v as ContractorCategory, r.outVendorType)
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
                        {r.category === "OUT_VENDOR" ? (
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
                                      save(r.displayName, r.category, next);
                                    }}
                                  />
                                  {t.label}
                                </label>
                              );
                            })}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
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
