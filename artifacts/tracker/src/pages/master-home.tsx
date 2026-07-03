import { Link } from "wouter";
import {
  Factory,
  ShieldCheck,
  DraftingCompass,
  CalendarRange,
  Wallet,
  ArrowRight,
} from "lucide-react";

type Tile = {
  key: string;
  label: string;
  description: string;
  icon: typeof Factory;
  href?: string;
  status: "live" | "soon";
};

const tiles: Tile[] = [
  {
    key: "production",
    label: "Production",
    description: "Balance & activity tracking, ageing, turnaround and velocity across the fabrication floor.",
    icon: Factory,
    href: "/production",
    status: "live",
  },
  {
    key: "quality",
    label: "Quality",
    description: "Inspection, NCRs and quality clearance tracking.",
    icon: ShieldCheck,
    status: "soon",
  },
  {
    key: "engineering",
    label: "Engineering",
    description: "Drawings, revisions and design release tracking.",
    icon: DraftingCompass,
    status: "soon",
  },
  {
    key: "planning",
    label: "Planning",
    description: "Schedules, load planning and milestone forecasting.",
    icon: CalendarRange,
    status: "soon",
  },
  {
    key: "finance",
    label: "Finance",
    description: "Costing, billing and financial reconciliation.",
    icon: Wallet,
    status: "soon",
  },
];

export default function MasterHome() {
  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <header className="border-b border-border bg-sidebar">
        <div className="max-w-6xl mx-auto px-4 md:px-6 py-6 md:py-8">
          <div className="text-xs md:text-sm font-medium tracking-[0.2em] text-primary uppercase">
            Vijay Transmission
          </div>
          <h1 className="mt-1 text-2xl md:text-4xl font-bold tracking-tight">
            Master Tracker
          </h1>
          <p className="mt-2 text-sm md:text-base text-muted-foreground max-w-2xl">
            Operational control across every department. Select a workspace to continue.
          </p>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 md:px-6 py-6 md:py-10">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-5">
          {tiles.map((tile) => {
            const Icon = tile.icon;
            const isLive = tile.status === "live";

            const inner = (
              <div
                className={`group relative h-full rounded-xl border p-5 md:p-6 transition-all ${
                  isLive
                    ? "border-primary/30 bg-card hover:border-primary hover:shadow-lg cursor-pointer"
                    : "border-border bg-card/60 cursor-not-allowed"
                }`}
              >
                <div className="flex items-start justify-between">
                  <div
                    className={`flex h-11 w-11 md:h-12 md:w-12 items-center justify-center rounded-lg ${
                      isLive
                        ? "bg-primary/10 text-primary"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    <Icon className="h-6 w-6" strokeWidth={2} />
                  </div>
                  {isLive ? (
                    <span className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-primary">
                      Live
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Coming soon
                    </span>
                  )}
                </div>

                <h2
                  className={`mt-4 text-lg md:text-xl font-semibold ${
                    isLive ? "text-foreground" : "text-muted-foreground"
                  }`}
                >
                  {tile.label}
                </h2>
                <p className="mt-1.5 text-sm text-muted-foreground leading-relaxed">
                  {tile.description}
                </p>

                {isLive && (
                  <div className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-primary">
                    Open workspace
                    <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                  </div>
                )}
              </div>
            );

            if (isLive && tile.href) {
              return (
                <Link key={tile.key} href={tile.href} className="block h-full">
                  {inner}
                </Link>
              );
            }

            return (
              <div
                key={tile.key}
                aria-disabled="true"
                title={`${tile.label} (coming soon)`}
                className="h-full select-none"
              >
                {inner}
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}
