// Theme upgrade: the one segmented control (Today's Priority / By type,
// Money's views, Schedule's Calendar / List, the appointments toolbar). It
// used to be the same literal class string copied into four files; the
// track and segment are decided here once. 44px targets on touch, 28px on
// desktop; the selected segment is a white chip with the control lift.

// w-fit: never stretched by a column flex parent; scrolls rather than overflows on a narrow screen.
export const segmentedTrackClass = "inline-flex w-fit max-w-full gap-0.5 overflow-x-auto rounded-md bg-inset p-0.5";

export function segmentedItemClass(active: boolean): string {
  return `inline-flex min-h-11 items-center shrink-0 whitespace-nowrap rounded-[5px] px-3 text-[13px] font-medium transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-7 ${
    active ? "bg-surface text-ink shadow-control ring-1 ring-line" : "text-ink-3 hover:text-ink"
  }`;
}
