"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { Badge, type BadgeTone } from "@/lib/ui/badge";
import type { StageTone } from "./demo-data";

/** Flush label/value row - mirrors app/(app)/dashboard/_components/business-glance.tsx's own local Row (that file keeps its own copy rather than importing across route boundaries; this demo does the same). */
export function DemoRow({ label, value, description }: { label: string; value: ReactNode; description?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <span className="text-sm text-ink-2">{label}</span>
      <span className="text-right">
        <span className="text-sm font-semibold tabular-nums text-ink">{value}</span>
        {description ? <span className="ml-1.5 text-xs text-ink-3">{description}</span> : null}
      </span>
    </div>
  );
}

/** Horizontal inline label/value strip - mirrors the flex-wrap border-y band used at the top of /dashboard, /agency, and other pages for a quiet reference-metric row. */
export function DemoMetricStrip({ items, className = "" }: { items: { label: string; value: string }[]; className?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-x-8 gap-y-3 border-y border-line py-4 ${className}`}>
      {items.map((item) => (
        <div key={item.label} className="flex items-baseline gap-2">
          <span className="text-sm text-ink-2">{item.label}</span>
          <span className="text-sm font-semibold tabular-nums text-ink">{item.value}</span>
        </div>
      ))}
    </div>
  );
}

const STAGE_TONE_TO_BADGE: Record<StageTone, BadgeTone> = {
  neutral: "neutral",
  info: "info",
  success: "success",
  warning: "warning",
  danger: "danger",
};

export function StageBadge({ label, tone }: { label: string; tone: StageTone }) {
  return <Badge tone={STAGE_TONE_TO_BADGE[tone]}>{label}</Badge>;
}

/**
 * A handful of buttons in this demo (Add customer, New estimate, etc.) look
 * like real create actions but this route never writes anywhere - there is
 * no backend, no database, and no form behind them. Rather than a dead
 * button (fails the "no fake interactions" bar in a worse way - it looks
 * broken) or a fabricated success message (implies a real mutation
 * happened), clicking one shows a small, honest, self-dismissing notice
 * that this is a demo. One shared context avoids duplicating that toast
 * markup/state across every view.
 */
type DemoActionContextValue = { announce: (message: string) => void };
const DemoActionContext = createContext<DemoActionContextValue | null>(null);

export function DemoActionProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);

  const announce = useCallback((next: string) => {
    setMessage(next);
    window.setTimeout(() => {
      setMessage((current) => (current === next ? null : current));
    }, 3200);
  }, []);

  const value = useMemo(() => ({ announce }), [announce]);

  return (
    <DemoActionContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className={`pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4 transition-opacity duration-200 ${
          message ? "opacity-100" : "opacity-0"
        }`}
      >
        {message ? (
          <div className="pointer-events-auto rounded-lg border border-line bg-ink px-4 py-2.5 text-sm font-medium text-white shadow-popover">
            {message}
          </div>
        ) : null}
      </div>
    </DemoActionContext.Provider>
  );
}

export function useDemoAction(): (message?: string) => void {
  const ctx = useContext(DemoActionContext);
  if (!ctx) throw new Error("useDemoAction must be used within DemoActionProvider");
  return (message?: string) => ctx.announce(message ?? "This is a demo - book time to set this up for your business.");
}
