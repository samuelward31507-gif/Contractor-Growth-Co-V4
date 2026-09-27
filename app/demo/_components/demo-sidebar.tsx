"use client";

import { useState } from "react";
import {
  LayoutDashboard,
  Users2,
  TrendingUp,
  Calendar,
  Briefcase,
  Star,
  Workflow,
  Menu,
  X,
  CheckCircle2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/lib/ui/badge";
import type { DemoView } from "./demo-data";
import { DEMO_BUSINESS_NAME } from "./demo-data";

const NAV_ITEMS: { view: DemoView; label: string; icon: LucideIcon }[] = [
  { view: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { view: "customers", label: "Customers", icon: Users2 },
  { view: "opportunities", label: "Opportunities", icon: TrendingUp },
  { view: "schedule", label: "Schedule", icon: Calendar },
  { view: "work", label: "Estimates & Jobs", icon: Briefcase },
  { view: "growth", label: "Reviews & Referrals", icon: Star },
  { view: "automations", label: "Automations", icon: Workflow },
];

function BrandLockup() {
  return (
    <div className="relative flex items-center gap-2.5 px-5 pb-3 pt-6">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-emerald-500 text-sm font-bold text-slate-950">
        T
      </span>
      <div className="min-w-0">
        <span className="block text-[15px] font-semibold leading-tight tracking-tight text-white">Trackpr</span>
        <p className="truncate text-[9.5px] font-semibold uppercase tracking-[0.16em] text-emerald-400/80">
          Contractor Growth Co.
        </p>
      </div>
    </div>
  );
}

function DemoContent({ activeView, onNavigate }: { activeView: DemoView; onNavigate: (view: DemoView) => void }) {
  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-[#0a120f]">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_40%_at_50%_-15%,rgba(16,185,129,0.10),transparent)]"
      />

      <BrandLockup />

      <div className="relative px-5 pb-4">
        <Badge tone="success" surface="dark">
          Interactive demo
        </Badge>
      </div>

      <div className="relative mx-4 mb-3 flex items-center gap-2 truncate rounded-lg bg-white/[0.04] px-3 py-2 ring-1 ring-inset ring-white/[0.07]">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" aria-hidden />
        <p className="truncate text-xs font-medium text-slate-300">{DEMO_BUSINESS_NAME}</p>
      </div>

      <nav className="relative flex-1 space-y-0.5 overflow-y-auto px-3 pb-4">
        {NAV_ITEMS.map((item) => {
          const active = item.view === activeView;
          const Icon = item.icon;
          return (
            <button
              key={item.view}
              type="button"
              onClick={() => onNavigate(item.view)}
              aria-current={active ? "page" : undefined}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60 ${
                active
                  ? "bg-emerald-500/[0.14] font-semibold text-white ring-1 ring-inset ring-emerald-500/25"
                  : "text-slate-400 hover:bg-white/[0.05] hover:text-white"
              }`}
            >
              <Icon className={`h-[18px] w-[18px] shrink-0 ${active ? "text-emerald-400" : "text-slate-500"}`} aria-hidden />
              <span className="truncate">{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="relative border-t border-white/[0.07] p-4">
        <div className="flex items-start gap-2.5">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-medium text-white">System healthy</p>
            <p className="mt-0.5 text-xs leading-snug text-slate-500">
              Automations, messaging, and AI are operating normally.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function DemoSidebar({ activeView, onNavigate }: { activeView: DemoView; onNavigate: (view: DemoView) => void }) {
  return (
    <aside className="hidden w-64 shrink-0 border-r border-white/[0.06] bg-[#0a120f] lg:flex">
      <DemoContent activeView={activeView} onNavigate={onNavigate} />
    </aside>
  );
}

export function DemoMobileNav({ activeView, onNavigate }: { activeView: DemoView; onNavigate: (view: DemoView) => void }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="lg:hidden">
      <header className="relative flex items-center justify-between overflow-hidden border-b border-white/[0.06] bg-[#0a120f] px-4 py-3">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_80%_at_20%_-30%,rgba(16,185,129,0.10),transparent)]"
        />
        <span className="relative flex items-center gap-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-emerald-500 text-xs font-bold text-slate-950">
            T
          </span>
          <span className="min-w-0">
            <span className="block text-[15px] font-semibold leading-tight tracking-tight text-white">Trackpr</span>
            <span className="block text-[9px] font-semibold uppercase tracking-[0.14em] text-emerald-400/80">Interactive demo</span>
          </span>
        </span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          className="relative flex h-9 w-9 items-center justify-center rounded-lg text-slate-300 transition-colors hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a120f]"
        >
          <Menu className="h-5 w-5" aria-hidden />
        </button>
      </header>

      <div className={`fixed inset-0 z-50 ${open ? "" : "pointer-events-none"}`} aria-hidden={!open}>
        <button
          type="button"
          aria-label="Close menu"
          tabIndex={open ? 0 : -1}
          className={`absolute inset-0 bg-slate-950/60 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0"}`}
          onClick={() => setOpen(false)}
        />
        <div
          className={`absolute inset-y-0 left-0 w-72 max-w-[85vw] shadow-2xl transition-transform duration-200 ease-out ${
            open ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="flex justify-end bg-[#0a120f] px-3 pt-3">
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close menu"
              tabIndex={open ? 0 : -1}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a120f]"
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
          </div>
          <div className="h-[calc(100%-3.25rem)]">
            <DemoContent
              activeView={activeView}
              onNavigate={(view) => {
                onNavigate(view);
                setOpen(false);
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
