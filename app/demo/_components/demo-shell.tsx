"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertCircle } from "lucide-react";
import { primaryButtonAutoClass } from "@/lib/ui/form";
import { DemoSidebar, DemoMobileNav } from "./demo-sidebar";
import { DemoActionProvider } from "./demo-shared";
import {
  DemoAutomationsView,
  DemoCustomersView,
  DemoDashboardView,
  DemoGrowthView,
  DemoOpportunitiesView,
  DemoScheduleView,
  DemoWorkView,
} from "./demo-views";
import type { DemoView } from "./demo-data";

const VIEW_LABEL: Record<DemoView, string> = {
  dashboard: "Dashboard",
  customers: "Customers",
  opportunities: "Opportunities",
  schedule: "Schedule",
  work: "Estimates & Jobs",
  growth: "Reviews & Referrals",
  automations: "Automations",
};

function ActiveView({ view }: { view: DemoView }) {
  switch (view) {
    case "dashboard":
      return <DemoDashboardView />;
    case "customers":
      return <DemoCustomersView />;
    case "opportunities":
      return <DemoOpportunitiesView />;
    case "schedule":
      return <DemoScheduleView />;
    case "work":
      return <DemoWorkView />;
    case "growth":
      return <DemoGrowthView />;
    case "automations":
      return <DemoAutomationsView />;
    default:
      return null;
  }
}

/**
 * The public, read-only sales-demo shell. Mirrors app/(app)/layout.tsx's
 * real structure (dark sidebar + mobile header + top bar + one scrolling
 * <main>) so a prospect's first impression matches the actual product, but
 * everything here is self-contained: no auth, no Supabase, no data fetch -
 * `activeView` is plain client state, and every view renders from the
 * static data in demo-data.ts. Switching sections never navigates or
 * reloads the page.
 */
export function DemoShell() {
  const [activeView, setActiveView] = useState<DemoView>("dashboard");

  return (
    <DemoActionProvider>
      <div className="flex h-dvh flex-col overflow-hidden bg-canvas lg:flex-row">
        <DemoSidebar activeView={activeView} onNavigate={setActiveView} />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <DemoMobileNav activeView={activeView} onNavigate={setActiveView} />

          <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-2.5 sm:px-6 lg:min-h-14 lg:border-line/80 lg:bg-canvas lg:px-10 lg:py-0">
            <p className="hidden truncate text-sm text-ink-3 sm:block">
              Demo <span className="text-ink-4">/</span> <span className="font-medium text-ink">{VIEW_LABEL[activeView]}</span>
            </p>
            <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-4">
              <Link
                href="/"
                className="inline-flex min-h-11 items-center rounded text-sm font-medium text-ink-3 transition-colors hover:text-ink sm:min-h-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
              >
                Exit demo
              </Link>
              <Link href="/get-started" className={primaryButtonAutoClass}>
                See it for my business
              </Link>
            </div>
          </div>

          <div className="flex items-start gap-2.5 border-b border-warning-border bg-warning-muted px-4 py-2.5 text-sm text-warning-text sm:px-6 lg:px-10">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <p>Demo data. This account is a realistic example for presentations. No real customer information is used.</p>
          </div>

          <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <ActiveView view={activeView} />
          </main>
        </div>
      </div>
    </DemoActionProvider>
  );
}
