import { Link } from "wouter";
import { Activity, ArrowRight, Boxes, Factory, PackageCheck } from "lucide-react";

export default function MasterHome() {
  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <header className="border-b border-border bg-sidebar">
        <div className="mx-auto max-w-6xl px-4 py-8 md:px-6 md:py-12">
          <div className="text-xs font-medium uppercase tracking-[0.24em] text-primary md:text-sm">
            Vijay Transmission
          </div>
          <h1 className="mt-3 text-3xl font-bold tracking-tight md:text-5xl">
            Production Control Center
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground md:text-base">
            One workspace for live WIP balances, production movement, ageing,
            inventory, orders, and dispatch across the fabrication floor.
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 md:px-6 md:py-12">
        <Link href="/production" className="group block">
          <section className="relative overflow-hidden rounded-2xl border border-primary/40 bg-card p-6 shadow-sm transition-colors hover:border-primary md:p-10">
            <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full border border-primary/15" />
            <div className="pointer-events-none absolute -right-10 -top-10 h-44 w-44 rounded-full border border-primary/20" />
            <div className="relative flex flex-col justify-between gap-10 md:flex-row md:items-end">
              <div className="max-w-2xl">
                <div className="flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Factory className="h-6 w-6" strokeWidth={2} />
                  </div>
                  <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-primary">
                    Live workspace
                  </span>
                </div>
                <h2 className="mt-7 text-3xl font-bold tracking-tight md:text-4xl">
                  Production
                </h2>
                <p className="mt-3 max-w-xl text-base leading-7 text-muted-foreground md:text-lg">
                  Balance and activity tracking for the complete steel-fabrication
                  workflow, from source files to actionable production decisions.
                </p>
                <div className="mt-7 inline-flex items-center gap-2 text-sm font-semibold text-primary">
                  Open Production Tracker
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                </div>
              </div>

              <div className="grid w-full max-w-md grid-cols-3 gap-3 md:w-[28rem]">
                <div className="rounded-xl border border-border bg-background/60 p-4">
                  <Activity className="h-5 w-5 text-primary" />
                  <div className="mt-8 text-sm font-semibold">WIP & ageing</div>
                </div>
                <div className="rounded-xl border border-border bg-background/60 p-4">
                  <Boxes className="h-5 w-5 text-primary" />
                  <div className="mt-8 text-sm font-semibold">Inventory</div>
                </div>
                <div className="rounded-xl border border-border bg-background/60 p-4">
                  <PackageCheck className="h-5 w-5 text-primary" />
                  <div className="mt-8 text-sm font-semibold">Orders & dispatch</div>
                </div>
              </div>
            </div>
          </section>
        </Link>
      </main>
    </div>
  );
}
