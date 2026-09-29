"use client";

import { useEffect, useRef, useState } from "react";
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
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/lib/ui/badge";
import { StatusLabel } from "@/lib/ui/status-dot";
import { BrandMark } from "@/app/(app)/_components/sidebar-content";
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

/** Trackpr 2.0 (step 2G): the same small brand row as the real app's sidebar header. */
function BrandLockup() {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-4">
      <BrandMark />
      <div className="min-w-0 leading-tight">
        <p className="text-[13px] font-semibold text-ink">Trackpr</p>
        <p className="truncate text-[11.5px] text-ink-3">{DEMO_BUSINESS_NAME}</p>
      </div>
    </div>
  );
}

const FOCUS_RING = "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

/**
 * The demo's navigation. Trackpr 2.0 (step 2G): the real app's light
 * sidebar language (white surface, quiet rows, selected fill + pine icon
 * for the active view) so the demo shows the product as it actually looks.
 * The demo's own views and their behavior are unchanged.
 */
function DemoContent({ activeView, onNavigate }: { activeView: DemoView; onNavigate: (view: DemoView) => void }) {
  return (
    <div className="flex h-full w-full flex-col bg-surface">
      <BrandLockup />

      <div className="px-4 pt-3">
        <Badge tone="success">Interactive demo</Badge>
      </div>

      <nav aria-label="Demo" className="flex-1 space-y-px overflow-y-auto px-2 py-3">
        {NAV_ITEMS.map((item) => {
          const active = item.view === activeView;
          const Icon = item.icon;
          return (
            <button
              key={item.view}
              type="button"
              onClick={() => onNavigate(item.view)}
              aria-current={active ? "page" : undefined}
              className={`group/nav flex min-h-11 w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium transition-colors duration-150 lg:min-h-8 ${FOCUS_RING} ${
                active ? "bg-selected text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"
              }`}
            >
              <Icon className={`h-4 w-4 shrink-0 ${active ? "text-accent" : "text-ink-3 group-hover/nav:text-ink-2"}`} strokeWidth={1.75} aria-hidden />
              <span className="truncate">{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="border-t border-line p-4">
        <StatusLabel tone="healthy">System healthy</StatusLabel>
        <p className="mt-1 text-xs leading-snug text-ink-3">Automations, messaging, and AI are operating normally.</p>
      </div>
    </div>
  );
}

export function DemoSidebar({ activeView, onNavigate }: { activeView: DemoView; onNavigate: (view: DemoView) => void }) {
  return (
    <aside aria-label="Demo navigation" className="hidden w-60 shrink-0 border-r border-line bg-surface lg:flex">
      <DemoContent activeView={activeView} onNavigate={onNavigate} />
    </aside>
  );
}

export function DemoMobileNav({ activeView, onNavigate }: { activeView: DemoView; onNavigate: (view: DemoView) => void }) {
  const [open, setOpen] = useState(false);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeButtonRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      openButtonRef.current?.focus();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <div className="lg:hidden">
      <header className="flex h-12 items-center justify-between gap-3 border-b border-line bg-surface pl-4 pr-1.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <BrandMark />
          <div className="min-w-0 leading-tight">
            <p className="text-[13px] font-semibold text-ink">Trackpr</p>
            <p className="truncate text-[11.5px] text-ink-3">Interactive demo</p>
          </div>
        </div>
        <button
          ref={openButtonRef}
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          aria-haspopup="dialog"
          aria-expanded={open}
          className={`flex h-11 w-11 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-hover hover:text-ink ${FOCUS_RING}`}
        >
          <Menu className="h-5 w-5" strokeWidth={1.75} aria-hidden />
        </button>
      </header>

      <div className={`fixed inset-0 z-50 ${open ? "" : "pointer-events-none"}`} inert={!open}>
        <button
          type="button"
          aria-label="Close menu"
          tabIndex={-1}
          className={`absolute inset-0 bg-ink/25 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0"}`}
          onClick={() => setOpen(false)}
        />
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Demo menu"
          className={`absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-line bg-surface shadow-popover transition-transform duration-200 ease-out ${
            open ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="flex justify-end px-1.5 pt-1.5">
            <button
              ref={closeButtonRef}
              type="button"
              onClick={() => {
                setOpen(false);
                openButtonRef.current?.focus();
              }}
              aria-label="Close menu"
              className={`flex h-11 w-11 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-hover hover:text-ink ${FOCUS_RING}`}
            >
              <X className="h-5 w-5" strokeWidth={1.75} aria-hidden />
            </button>
          </div>
          <div className="min-h-0 flex-1">
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
