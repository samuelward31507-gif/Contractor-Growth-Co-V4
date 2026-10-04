import Link from "next/link";
import { segmentedItemClass, segmentedTrackClass } from "@/lib/ui/segmented";

export type TodayView = "priority" | "by-type";

/**
 * The two views of Today's third act, "Opportunities": the preview in
 * priority order, and every open opportunity grouped by type (the
 * Opportunities nav entry lands here, /today?view=by-type#opportunities).
 * Both keep the #opportunities fragment so switching stays on the act.
 * Trackpr 2.0 (step 2E): restyled onto the tokens - a quiet segmented
 * control, 44px targets on touch.
 */
export function TodayViewTabs({ active, opportunityCount }: { active: TodayView; opportunityCount: number }) {
  const items: { value: TodayView; label: string; href: string }[] = [
    { value: "priority", label: "Priority", href: "/today#opportunities" },
    { value: "by-type", label: `By type${opportunityCount > 0 ? ` (${opportunityCount})` : ""}`, href: "/today?view=by-type#opportunities" },
  ];

  return (
    <div className={segmentedTrackClass} role="group" aria-label="Opportunities view">
      {items.map((item) => (
        <Link
          key={item.value}
          href={item.href}
          aria-pressed={active === item.value}
          className={segmentedItemClass(active === item.value)}
        >
          {item.label}
        </Link>
      ))}
    </div>
  );
}
