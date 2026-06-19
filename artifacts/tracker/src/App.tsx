import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TrackerProvider } from "@/lib/store";
import { Layout } from "@/components/layout";
import NotFound from "@/pages/not-found";

import Overview from "@/pages/overview";
import ActivityView from "@/pages/activity";
import AgeingView from "@/pages/ageing";
import ContractorView from "@/pages/contractor";
import DataView from "@/pages/data";

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Overview} />
        <Route path="/activity" component={ActivityView} />
        <Route path="/ageing" component={AgeingView} />
        <Route path="/contractor" component={ContractorView} />
        <Route path="/data" component={DataView} />
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
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
        </TrackerProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
