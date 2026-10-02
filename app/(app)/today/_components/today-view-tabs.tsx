import Link from "next/link";

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
    <div className="inline-flex gap-0.5 rounded-md bg-inset p-0.5" role="group" aria-label="Opportunities view">
      {items.map((item) => (
        <Link
          key={item.value}
          href={item.href}
          aria-pressed={active === item.value}
          className={`inline-flex min-h-11 items-center rounded-[5px] px-3 text-[13px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-7 ${
            active === item.value ? "bg-surface text-ink shadow-[0_1px_2px_rgba(23,25,26,0.08)]" : "text-ink-3 hover:text-ink"
          }`}
        >
          {item.label}
        </Link>
      ))}
    </div>
  );
}
