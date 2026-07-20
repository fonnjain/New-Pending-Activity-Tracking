import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TrackerProvider } from "@/lib/store";
import { SettingsProvider } from "@/lib/settings";
import { Layout } from "@/components/layout";
import NotFound from "@/pages/not-found";
import { useGetAuthStatus, getGetAuthStatusQueryKey } from "@workspace/api-client-react";
import { useActivityHeartbeat } from "@/lib/useActivityHeartbeat";

import MasterHome from "@/pages/master-home";
import Overview from "@/pages/overview";
import TurnaroundView from "@/pages/turnaround";
import StuckProjectsView from "@/pages/stuck-projects";
import JobDashboard from "@/pages/job-dashboard";
import ActivityView from "@/pages/activity";
import ContractorView from "@/pages/contractor";
import PlantOperationView from "@/pages/plant-operation";
import DataView from "@/pages/data";
import ReportsView from "@/pages/reports";
import OrderStatusView from "@/pages/order-status";
import InventoryView from "@/pages/inventory";

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

function ProductionTracker() {
  return (
    <Layout>
      <ScrollToTop />
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
        <Route component={NotFound} />
      </Switch>
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
              <Router />
            </WouterRouter>
          </SettingsProvider>
        </TrackerProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
