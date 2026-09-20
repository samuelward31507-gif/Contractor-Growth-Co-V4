"use client";

import { useState } from "react";
import { Menu, X } from "lucide-react";
import { SidebarContent } from "./sidebar-content";

export function MobileNav({
  organizationName,
  userEmail,
  role,
  showAgencyLink,
}: {
  organizationName: string;
  userEmail: string;
  role: string;
  showAgencyLink: boolean;
}) {
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
            <span className="block text-[9px] font-semibold uppercase tracking-[0.14em] text-emerald-400/80">Contractor Growth Co.</span>
          </span>
        </span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          className="relative flex h-9 w-9 items-center justify-center rounded-lg text-slate-300 transition-colors hover:bg-white/[0.06]"
        >
          <Menu className="h-5 w-5" aria-hidden />
        </button>
      </header>

      {/* Always mounted (not conditionally rendered) so open/close animates
          rather than snapping - same pattern as the marketing site's mobile
          drawer, adapted for this dark surface. */}
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
              className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/[0.06]"
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
          </div>
          <div className="h-[calc(100%-3.25rem)]">
            <SidebarContent
              organizationName={organizationName}
              userEmail={userEmail}
              role={role}
              showAgencyLink={showAgencyLink}
              onNavigate={() => setOpen(false)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
