"use client";

import { useEffect, useRef, useState } from "react";
import { Menu, X } from "lucide-react";
import { BrandMark } from "@/app/(app)/_components/sidebar-content";
import { AgencySidebarContent } from "./agency-sidebar-content";

/**
 * Agency's mobile header and menu drawer. Trackpr 2.0 (step 2G): the same
 * light header as the client app's merged mobile header, and a light drawer
 * holding the same navigation as the desktop sidebar. `inert` keeps the
 * closed drawer out of the tab order; Escape closes it and focus returns to
 * the menu button.
 */
export function AgencyMobileNav({ userEmail, isAdmin }: { userEmail: string; isAdmin: boolean }) {
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
            <p className="truncate text-[11.5px] text-ink-3">Agency Command Center</p>
          </div>
        </div>
        <button
          ref={openButtonRef}
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          aria-haspopup="dialog"
          aria-expanded={open}
          className="flex h-11 w-11 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-hover hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
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
          aria-label="Agency menu"
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
              className="flex h-11 w-11 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-hover hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <X className="h-5 w-5" strokeWidth={1.75} aria-hidden />
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <AgencySidebarContent userEmail={userEmail} isAdmin={isAdmin} onNavigate={() => setOpen(false)} />
          </div>
        </div>
      </div>
    </div>
  );
}
