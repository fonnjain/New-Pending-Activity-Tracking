import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { useEffect, lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TrackerProvider } from "@/lib/store";
import { SettingsProvider } from "@/lib/settings";
import { Layout } from "@/components/layout";
import NotFound from "@/pages/not-found";
import { useGetAuthStatus, getGetAuthStatusQueryKey } from "@workspace/api-client-react";
import { useActivityHeartbeat } from "@/lib/useActivityHeartbeat";

// Route-level code splitting — each page is a separate JS chunk loaded on demand.
// First visit fetches the chunk; subsequent visits are instant (browser cache).
const MasterHome        = lazy(() => import("@/pages/master-home"));
const Overview          = lazy(() => import("@/pages/overview"));
const TurnaroundView    = lazy(() => import("@/pages/turnaround"));
const StuckProjectsView = lazy(() => import("@/pages/stuck-projects"));
const JobDashboard      = lazy(() => import("@/pages/job-dashboard"));
const ActivityView      = lazy(() => import("@/pages/activity"));
const ContractorView    = lazy(() => import("@/pages/contractor"));
const PlantOperationView = lazy(() => import("@/pages/plant-operation"));
const DataView          = lazy(() => import("@/pages/data"));
const BucketListDatesPage = lazy(() =>
  import("@/pages/data").then((m) => ({ default: m.BucketListDatesPage }))
);
const ReportsView       = lazy(() => import("@/pages/reports"));
const OrderStatusView   = lazy(() => import("@/pages/order-status"));
const InventoryView     = lazy(() => import("@/pages/inventory"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      gcTime: 30 * 60 * 1000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: 1,
    },
  },
});

function ScrollToTop() {
  const [location] = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location]);
  return null;
}

/** Shown inside the Layout chrome while a page chunk is downloading. */
function PageLoader() {
  return (
    <div className="flex items-center justify-center h-64 w-full">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
    </div>
  );
}

function ProductionTracker() {
  return (
    <Layout>
      <ScrollToTop />
      <Suspense fallback={<PageLoader />}>
        <Switch>
          <Route path="/" component={Overview} />
          <Route path="/turnaround" component={TurnaroundView} />
          <Route path="/stuck" component={StuckProjectsView} />
          <Route path="/order-status" component={OrderStatusView} />
          <Route path="/inventory" component={InventoryView} />
          <Route path="/jobs" component={JobDashboard} />
          <Route path="/activity" component={ActivityView} />
          <Route path="/contractor" component={ContractorView} />
          <Route path="/plant" component={PlantOperationView} />
          <Route path="/contractor-setup" component={DataView} />
          <Route path="/data" component={DataView} />
          <Route path="/computed-fg" component={DataView} />
          <Route path="/order-reconciliation" component={DataView} />
          <Route path="/release-balance" component={DataView} />
          <Route path="/reports" component={ReportsView} />
          <Route path="/thickness" component={DataView} />
          <Route path="/warning-parameters" component={DataView} />
          <Route path="/users" component={DataView} />
          <Route path="/order-review-generated" component={DataView} />
          <Route path="/data-check" component={DataView} />
          <Route path="/erp-rules" component={DataView} />
          <Route path="/job-templates" component={DataView} />
          <Route path="/bucket-list-dates" component={BucketListDatesPage} />
          <Route component={NotFound} />
        </Switch>
      </Suspense>
    </Layout>
  );
}

// Legacy root paths from before the Production tracker was nested under
// /production. Kept so old bookmarks / deep links keep working.
const LEGACY_TRACKER_PATHS = [
  "/turnaround",
  "/stuck",
  "/order-status",
  "/jobs",
  "/activity",
  "/contractor",
  "/plant",
  "/contractor-setup",
  "/data",
  "/computed-fg",
  "/order-reconciliation",
  "/reports",
  "/thickness",
  "/warning-parameters",
  "/release-balance",
  "/order-review-generated",
  "/data-check",
  "/erp-rules",
  "/users",
  "/job-templates",
  "/bucket-list-dates",
];

function Router() {
  return (
    <Switch>
      <Route path="/" component={MasterHome} />
      <Route path="/production" nest>
        <ProductionTracker />
      </Route>
      {LEGACY_TRACKER_PATHS.map((p) => (
        <Route key={p} path={p}>
          <Redirect to={`/production${p}`} />
        </Route>
      ))}
      <Route component={NotFound} />
    </Switch>
  );
}

function HeartbeatInner() {
  useActivityHeartbeat();
  return null;
}

function HeartbeatMount() {
  const { data: auth } = useGetAuthStatus({ query: { queryKey: getGetAuthStatusQueryKey() } });
  const isAuth = (auth as { authenticated?: boolean } | undefined)?.authenticated === true;
  return isAuth ? <HeartbeatInner /> : null;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <TrackerProvider>
          <SettingsProvider>
            <HeartbeatMount />
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
              <Suspense fallback={null}>
                <Router />
              </Suspense>
            </WouterRouter>
          </SettingsProvider>
        </TrackerProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
