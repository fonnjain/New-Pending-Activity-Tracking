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
  PROCESS_SEQUENCE,
} from "@workspace/domain";

// Ensure every canonical activity has an ideal-days value so the editor always
// renders a full row, and fill any missing top-level field from the defaults.
// Unknown extra keys are dropped (only PROCESS_SEQUENCE steps have a target).
function withDefaults(s: Partial<TurnaroundSettings> | undefined): TurnaroundSettings {
  const idealDays: Record<string, number> = {};
  for (const step of PROCESS_SEQUENCE) {
    const v = s?.idealDays?.[step];
    idealDays[step] =
      typeof v === "number" && Number.isFinite(v)
        ? v
        : DEFAULT_TURNAROUND_SETTINGS.idealDays[step];
  }
  return {
    idealDays,
    yellowMax: s?.yellowMax ?? DEFAULT_TURNAROUND_SETTINGS.yellowMax,
    orangeMax: s?.orangeMax ?? DEFAULT_TURNAROUND_SETTINGS.orangeMax,
    graceMode: s?.graceMode ?? DEFAULT_TURNAROUND_SETTINGS.graceMode,
    overrides: s?.overrides ?? {},
  };
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

  // Seed local state from the server exactly once; later saves keep the cache in
  // sync via setQueryData, so the draft is never clobbered while editing.
  useEffect(() => {
    if (data && !initialized.current) {
      initialized.current = true;
      setSettings(withDefaults(data));
    }
  }, [data]);

  const persist = useCallback(
    (next: TurnaroundSettings) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        update.mutate(
          { data: next },
          {
            onSuccess: (saved) => {
              queryClient.setQueryData(getGetSettingsQueryKey(), saved);
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
