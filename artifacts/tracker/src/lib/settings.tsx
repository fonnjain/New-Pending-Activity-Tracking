import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  ReactNode,
} from "react";
import {
  useGetSettings,
  useUpdateSettings,
  getGetSettingsQueryKey,
  type TurnaroundSettings,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_TURNAROUND_SETTINGS,
  migrateTurnaroundSettings,
} from "@workspace/domain";

// Ensure every canonical activity has a full per-activity row so the editor
// always renders the complete grid, normalizing/migrating any partial or legacy
// shape. Unknown extra keys are dropped (only PROCESS_SEQUENCE steps have a target).
function withDefaults(
  s: Partial<TurnaroundSettings> | undefined,
): TurnaroundSettings {
  if (!s) return DEFAULT_TURNAROUND_SETTINGS;
  return migrateTurnaroundSettings(s);
}

interface SettingsContextType {
  settings: TurnaroundSettings;
  // Patch the settings (live) and debounce-persist to the server.
  updateSettings: (
    patch:
      | Partial<TurnaroundSettings>
      | ((prev: TurnaroundSettings) => TurnaroundSettings),
  ) => void;
  reset: () => void;
  isLoading: boolean;
  saving: boolean;
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const { data, isLoading } = useGetSettings({
    query: { queryKey: getGetSettingsQueryKey() },
  });
  const update = useUpdateSettings();
  const queryClient = useQueryClient();

  const [settings, setSettings] = useState<TurnaroundSettings>(() =>
    withDefaults(undefined),
  );
  const initialized = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last persisted global WIP cutoff. When a save changes it, every
  // cutoff-scoped read must be refetched (see persist below).
  const lastValidFrom = useRef<string | null | undefined>(undefined);

  // Seed local state from the server exactly once; later saves keep the cache in
  // sync via setQueryData, so the draft is never clobbered while editing.
  useEffect(() => {
    if (data && !initialized.current) {
      initialized.current = true;
      const seeded = withDefaults(data);
      setSettings(seeded);
      lastValidFrom.current = seeded.validFromDate ?? null;
    }
  }, [data]);

  const persist = useCallback(
    (next: TurnaroundSettings) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        // Mark that this save has been dispatched; if the user keeps typing,
        // updateSettings schedules a new timer, so saveTimer.current becomes
        // non-null again and we skip reconciling stale (in-flight) values.
        saveTimer.current = null;
        update.mutate(
          { data: next },
          {
            onSuccess: (saved) => {
              queryClient.setQueryData(getGetSettingsQueryKey(), saved);
              // The global WIP cutoff scopes the imports list and every
              // server-side history replay (changes, movement, velocity,
              // milestones, order status). When it changes, invalidate those
              // cutoff-scoped reads so the whole app re-scopes to the new
              // window. Other settings edits (grace bands etc.) never touch it,
              // so this stays a no-op for the common case.
              const savedVf = withDefaults(saved).validFromDate ?? null;
              if (savedVf !== lastValidFrom.current) {
                lastValidFrom.current = savedVf;
                queryClient.invalidateQueries({
                  predicate: (q) => {
                    const k = q.queryKey?.[0];
                    return (
                      typeof k === "string" &&
                      (k.startsWith("/api/imports") ||
                        k.startsWith("/api/milestones") ||
                        k.startsWith("/api/order"))
                    );
                  },
                });
              }
              // Reconcile local draft to the server's normalized (validated,
              // band-ordered) values, but only if no newer edit is pending —
              // otherwise we'd clobber what the user is currently typing.
              if (!saveTimer.current) setSettings(withDefaults(saved));
            },
          },
        );
      }, 500);
    },
    [update, queryClient],
  );

  const updateSettings = useCallback<SettingsContextType["updateSettings"]>(
    (patch) => {
      setSettings((prev) => {
        const next =
          typeof patch === "function" ? patch(prev) : { ...prev, ...patch };
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const reset = useCallback(() => {
    const next = withDefaults(DEFAULT_TURNAROUND_SETTINGS);
    setSettings(next);
    persist(next);
  }, [persist]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  return (
    <SettingsContext.Provider
      value={{ settings, updateSettings, reset, isLoading, saving: update.isPending }}
    >
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextType {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}
