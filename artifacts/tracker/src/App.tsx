import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TrackerProvider } from "@/lib/store";
import { SettingsProvider } from "@/lib/settings";
import { Layout } from "@/components/layout";
import NotFound from "@/pages/not-found";

import Overview from "@/pages/overview";
import JobDashboard from "@/pages/job-dashboard";
import ActivityView from "@/pages/activity";
import AgeingView from "@/pages/ageing";
import ContractorView from "@/pages/contractor";
import DataView from "@/pages/data";
import ReportsView from "@/pages/reports";
import WarningParameters from "@/pages/warning-parameters";

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

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Overview} />
        <Route path="/jobs" component={JobDashboard} />
        <Route path="/activity" component={ActivityView} />
        <Route path="/ageing" component={AgeingView} />
        <Route path="/contractor" component={ContractorView} />
        <Route path="/data" component={DataView} />
        <Route path="/reports" component={ReportsView} />
        <Route path="/warning-parameters" component={WarningParameters} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <TrackerProvider>
          <SettingsProvider>
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
