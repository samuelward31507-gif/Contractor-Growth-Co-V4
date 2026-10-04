import type { ReactNode } from "react";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "./page";
import { cardClass } from "./surface";

/**
 * Performance Pass A: the building blocks for route-level loading.tsx
 * skeletons. Next.js shows a route's loading.tsx the moment a navigation to
 * it starts (the sidebar, top bar and mobile nav stay put - they belong to
 * the persistent (app) layout), so a click answers immediately instead of
 * waiting for the whole server render.
 *
 * Same visual language the existing skeletons already use
 * (app/(app)/jobs/loading.tsx, automations/loading.tsx): pale slate
 * `animate-pulse` blocks inside the real page container and the real
 * card/border shapes, so nothing jumps when content swaps in. Skeletons
 * render no data and no text at all - not even page titles, which vary by
 * vertical (e.g. People/Members) - so they can never show another
 * organization's, or a wrong, value.
 */

/** The shared page container every authenticated page uses. */
// The skeleton uses the exact page container, so swapping to content never
// shifts the layout.
export const SKELETON_PAGE_CLASS = PAGE_CONTAINER_CLASS;

export function Bone({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded bg-inset ${className}`} />;
}

/** The page wrapper: the real container plus an accessible, screen-reader-only loading status. */
export function SkeletonPage({ gap = "gap-8", width = "full", children }: { gap?: "gap-6" | "gap-8"; width?: "content" | "full"; children: ReactNode }) {
  return (
    <div className={`${SKELETON_PAGE_CLASS} ${gap} ${width === "content" ? PAGE_MAX_WIDTH_CLASS : ""}`} role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      {children}
    </div>
  );
}

/** Mirrors lib/ui/page-header.tsx: eyebrow, title, description, and an optional action on the right. */
export function SkeletonPageHeader({ action = false }: { action?: boolean }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <Bone className="mb-2.5 h-3 w-16" />
        <Bone className="h-7 w-44" />
        <Bone className="mt-2.5 h-4 w-80 max-w-full" />
      </div>
      {action ? <Bone className="h-9 w-32 rounded-lg" /> : null}
    </div>
  );
}

/** Mirrors lib/ui/stat-card.tsx: label + icon, value, description. */
export function SkeletonStatCard() {
  return (
    <div className={`${cardClass} p-5`}>
      <div className="flex items-start justify-between gap-3">
        <Bone className="h-3 w-24" />
        <Bone className="h-7 w-7 rounded-md" />
      </div>
      <Bone className="mt-3 h-7 w-20" />
      <Bone className="mt-2.5 h-3 w-36 max-w-full" />
    </div>
  );
}

/** Rows inside a bordered white card - the shape of every list/table on these pages. */
export function SkeletonRows({ count = 6, leading = true }: { count?: number; leading?: boolean }) {
  return (
    <div className={`overflow-hidden ${cardClass}`}>
      <div className="divide-y divide-line">
        {Array.from({ length: count }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3.5">
            {leading ? <Bone className="h-8 w-8 shrink-0 rounded-full" /> : null}
            <div className="min-w-0 flex-1">
              <Bone className="h-3.5 w-48 max-w-full" />
              <Bone className="mt-2 h-3 w-64 max-w-full" />
            </div>
            <Bone className="hidden h-5 w-20 rounded-full sm:block" />
          </div>
        ))}
      </div>
    </div>
  );
}
