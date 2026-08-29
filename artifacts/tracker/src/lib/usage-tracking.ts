import { useEffect, useRef } from "react";

const HEARTBEAT_MS = 60_000;
const RECENT_INTERACTION_MS = 90_000;

export const USAGE_INTERACTION_EVENTS = [
  "pointerdown",
  "keydown",
  "input",
  "scroll",
  "touchstart",
] as const;

type UsageInteractionEvent = typeof USAGE_INTERACTION_EVENTS[number];
type UsageHeartbeatState = "busy" | "idle";

type UsageEvent = {
  eventType: "page_visit" | "report_generated" | "visibility";
  pagePath?: string;
  pageLabel?: string;
  reportKey?: string;
};

export type UsageHeartbeatEnvironment = {
  now: () => number;
  isVisible: () => boolean;
  addInteractionListener: (
    event: UsageInteractionEvent,
    listener: () => void,
  ) => void;
  removeInteractionListener: (
    event: UsageInteractionEvent,
    listener: () => void,
  ) => void;
  addVisibilityChangeListener: (listener: () => void) => void;
  removeVisibilityChangeListener: (listener: () => void) => void;
  setInterval: (listener: () => void, delay: number) => number;
  clearInterval: (interval: number) => void;
  sendHeartbeat: (state: UsageHeartbeatState, pagePath: string) => void;
  recordVisibility: (pagePath: string, state: "visible" | "hidden") => void;
};

const PAGE_LABELS: Record<string, string> = {
  "/": "Overview",
  "/jobs": "Project Wise",
  "/activity": "Activity Wise",
  "/contractor": "Contractor Wise",
  "/plant": "Plant Operation Wise",
  "/inventory": "Bucket List",
  "/reports": "Reports",
  "/turnaround": "Turn Around Time",
  "/stuck": "Speed of Execution",
  "/data": "Data",
  "/job-templates": "Job Templates",
  "/computed-fg": "Computed FG",
  "/order-reconciliation": "Order Reconciliation",
  "/release-balance": "Release Balance",
  "/order-review-generated": "Generated Order Review",
  "/order-status": "Order Status",
  "/contractor-setup": "Contractor Setup",
  "/warning-parameters": "Warning Parameters",
  "/thickness": "Thickness",
  "/data-check": "Data Check",
  "/erp-rules": "ERP Rules",
  "/bucket-list-dates": "Bucket List Dates",
  "/users": "Users & Usage Activity",
};

function normalizedPath(path: string): string {
  return path.split(/[?#]/, 1)[0] || "/";
}

export function pageLabelForPath(path: string): string {
  const safePath = normalizedPath(path);
  return PAGE_LABELS[safePath] ?? (safePath.slice(1).replace(/[-_]+/g, " ") || "Overview");
}

/**
 * Product-usage telemetry is intentionally fire-and-forget. It submits only
 * page/report metadata and must never interrupt navigation or a download.
 */
export function recordUsageEvent(event: UsageEvent): void {
  void fetch("/api/auth/usage-event", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
    keepalive: true,
  }).catch(() => undefined);
}

function reportKeyForFilename(filename: string, fileType: string): string {
  const base = filename.toLowerCase().replace(/\.[^.]+$/, "");
  if (fileType === "zip") return "report_archive";
  if (fileType === "pdf") return "ai_turnaround_report";
  if (fileType === "json") return "import_data_export";
  if (fileType === "csv" && base.startsWith("item_master_thickness")) return "item_master_thickness";
  if (base.startsWith("plant-operation-fabrication")) return "plant_operation_fabrication";
  if (base.startsWith("plant-operation-galvanization")) return "plant_operation_galvanization";
  if (base.startsWith("contractor_performance")) return "contractor_performance";
  if (base.startsWith("fabrication_load")) return "fabrication_load";
  if (base.startsWith("generated_order_review")) return "generated_order_review";
  if (base.startsWith("report_")) return "report_export";
  return "spreadsheet_export";
}

export function trackReportGenerated(filename: string, fileType: string): void {
  recordUsageEvent({
    eventType: "report_generated",
    reportKey: reportKeyForFilename(filename, fileType),
  });
}

/**
 * Starts stateful browser activity tracking. The adapter keeps its timing and
 * interaction policy testable without needing to render a React component.
 */
export function createUsageHeartbeatTracker(
  getPagePath: () => string,
  environment: UsageHeartbeatEnvironment,
): () => void {
  let lastInteractionAt = environment.now();
  const markInteraction = () => {
    lastInteractionAt = environment.now();
  };
  const heartbeat = () => {
    const busy =
      environment.isVisible() &&
      environment.now() - lastInteractionAt <= RECENT_INTERACTION_MS;
    environment.sendHeartbeat(busy ? "busy" : "idle", getPagePath());
  };
  const onVisibilityChange = () => {
    const visibility = environment.isVisible() ? "visible" : "hidden";
    if (visibility === "visible") markInteraction();
    environment.recordVisibility(getPagePath(), visibility);
    heartbeat();
  };

  for (const event of USAGE_INTERACTION_EVENTS) {
    environment.addInteractionListener(event, markInteraction);
  }
  environment.addVisibilityChangeListener(onVisibilityChange);
  heartbeat();
  const interval = environment.setInterval(heartbeat, HEARTBEAT_MS);
  return () => {
    environment.clearInterval(interval);
    environment.removeVisibilityChangeListener(onVisibilityChange);
    for (const event of USAGE_INTERACTION_EVENTS) {
      environment.removeInteractionListener(event, markInteraction);
    }
  };
}

export function useUsageTracking(isAuthenticated: boolean, location: string): void {
  const locationRef = useRef(location);
  const lastTrackedPath = useRef<string | null>(null);

  useEffect(() => {
    locationRef.current = location;
  }, [location]);

  useEffect(() => {
    if (!isAuthenticated) {
      lastTrackedPath.current = null;
      return;
    }
    const pagePath = normalizedPath(location);
    if (lastTrackedPath.current === pagePath) return;
    lastTrackedPath.current = pagePath;
    recordUsageEvent({
      eventType: "page_visit",
      pagePath,
      pageLabel: pageLabelForPath(pagePath),
    });
  }, [isAuthenticated, location]);

  useEffect(() => {
    if (!isAuthenticated) return;

    return createUsageHeartbeatTracker(
      () => normalizedPath(locationRef.current),
      {
        now: () => Date.now(),
        isVisible: () => document.visibilityState === "visible",
        addInteractionListener: (event, listener) =>
          window.addEventListener(event, listener, { passive: true }),
        removeInteractionListener: (event, listener) =>
          window.removeEventListener(event, listener),
        addVisibilityChangeListener: (listener) =>
          document.addEventListener("visibilitychange", listener),
        removeVisibilityChangeListener: (listener) =>
          document.removeEventListener("visibilitychange", listener),
        setInterval: (listener, delay) => window.setInterval(listener, delay),
        clearInterval: (interval) => window.clearInterval(interval),
        sendHeartbeat: (state, pagePath) => {
          void fetch("/api/auth/heartbeat", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ state, pagePath }),
            keepalive: true,
          }).catch(() => undefined);
        },
        recordVisibility: (pagePath, state) => {
          recordUsageEvent({
            eventType: "visibility",
            pagePath,
            pageLabel: state,
          });
        },
      },
    );
  }, [isAuthenticated]);
}