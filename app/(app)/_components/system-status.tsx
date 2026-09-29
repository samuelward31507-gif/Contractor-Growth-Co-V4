"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { StatusDot } from "@/lib/ui/status-dot";
import type { SystemStatusView } from "./system-status-model";

const TEXT_TONE: Record<SystemStatusView["tone"], string> = {
  healthy: "text-ink-2 group-hover:text-ink",
  attention: "text-warning-text",
  critical: "text-danger-text",
  neutral: "text-ink-2 group-hover:text-ink",
};

// Healthy is nearly invisible - words and a pine dot, no chrome. An issue
// earns a quiet tinted fill so it reads before the text is parsed; color is
// never the only signal (the words always say it).
const SURFACE_TONE: Record<SystemStatusView["tone"], string> = {
  healthy: "group-hover:bg-hover",
  attention: "bg-warning-muted group-hover:bg-warning-muted/70",
  critical: "bg-danger-muted group-hover:bg-danger-muted/70",
  neutral: "group-hover:bg-hover",
};

/**
 * Trackpr 2.0 (step 2D): the top bar's system status - a compact indicator
 * that opens a short, business-language explanation. A non-modal popover:
 * focus moves into it on open, Escape or a click outside closes it (Escape
 * returns focus to the indicator), and it closes on navigation.
 */
export function SystemStatus({ view }: { view: SystemStatusView }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const headingId = useId();
  const pathname = usePathname();

  // Close when the route changes (e.g. after following "View details").
  const [openedOn, setOpenedOn] = useState(pathname);
  if (open && openedOn !== pathname) setOpen(false);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    }
    function onPointerDown(event: PointerEvent) {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          setOpenedOn(pathname);
          setOpen((current) => !current);
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`System status: ${view.label}`}
        className="group inline-flex min-h-11 items-center rounded-md focus:outline-none sm:min-h-8"
      >
        {/* The visible pill stays compact; the button around it is the
            44px touch target on small screens. */}
        <span
          className={`inline-flex h-7 items-center gap-2 rounded-md px-2.5 text-xs font-medium transition-colors duration-150 group-focus-visible:ring-2 group-focus-visible:ring-accent/40 ${TEXT_TONE[view.tone]} ${SURFACE_TONE[view.tone]}`}
        >
          <StatusDot tone={view.tone} />
          <span className="sm:hidden">{view.shortLabel}</span>
          <span className="hidden sm:inline">{view.label}</span>
        </span>
      </button>

      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-labelledby={headingId}
          tabIndex={-1}
          className="absolute right-0 top-full z-50 mt-2 w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-4 text-left shadow-popover focus:outline-none"
        >
          <div className="flex items-center gap-2">
            <StatusDot tone={view.tone} />
            <h2 id={headingId} className="text-sm font-semibold text-ink">
              {view.headline}
            </h2>
          </div>

          {view.issues.length > 0 ? (
            <ul className="mt-3 space-y-1.5">
              {view.issues.map((issue) => (
                <li key={issue} className="text-sm leading-5 text-ink">
                  {issue}
                </li>
              ))}
            </ul>
          ) : null}

          <p className="mt-2 text-[13px] leading-5 text-ink-3">{view.body}</p>

          {view.tone !== "healthy" ? (
            <Link
              href={view.detailsHref}
              onClick={() => setOpen(false)}
              className="mt-3 inline-flex min-h-11 items-center gap-1 rounded-md text-[13px] font-medium text-accent hover:text-accent-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-8"
            >
              View details
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
