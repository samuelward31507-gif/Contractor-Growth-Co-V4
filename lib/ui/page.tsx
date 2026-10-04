import type { ReactNode } from "react";

/**
 * Trackpr 2.0 design system (step 2A): the one page container every screen
 * in the app shell sits in - the padding rhythm 38 pages previously repeated
 * as a literal class string. Pages move onto PageContainer as they are
 * redesigned; until then the literal and this constant are byte-identical,
 * and the loading skeletons (lib/ui/skeleton.tsx) use the same constant, so
 * the swap from skeleton to content never shifts the layout.
 */
export const PAGE_CONTAINER_CLASS = "flex flex-1 flex-col px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-9";

const GAP: Record<"compact" | "default", string> = {
  compact: "gap-6",
  default: "gap-8",
};

/**
 * Trackpr 2.0 (step 2E): the shared maximum content width - 1280px
 * including the page gutters (so ~1200px of content at lg), centered in the
 * content area. "full" keeps edge-to-edge for screens that genuinely need
 * the room (wide tables, calendars).
 */
export const PAGE_MAX_WIDTH_CLASS = "mx-auto w-full max-w-[1520px]";

export function PageContainer({ gap = "default", width = "content", children }: { gap?: "compact" | "default"; width?: "content" | "full"; children: ReactNode }) {
  return <div className={`${PAGE_CONTAINER_CLASS} ${GAP[gap]} ${width === "content" ? PAGE_MAX_WIDTH_CLASS : ""}`}>{children}</div>;
}
