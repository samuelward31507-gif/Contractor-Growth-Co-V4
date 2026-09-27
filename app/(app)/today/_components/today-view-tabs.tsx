import Link from "next/link";

export type TodayView = "priority" | "by-type";

/**
 * IA consolidation pass: Opportunities is no longer its own primary nav
 * destination - this is the "view/filter within Today" the audit called
 * for. Same segmented-control pattern WorkTabs/RangeTabs/Appointments'
 * Upcoming-Today-Past tabs already use (rounded-lg border bg-slate-50 p-1,
 * pressed segment gets bg-white shadow-sm) - a real view switch under one
 * persistent "Today" header, not a navigation to a different page.
 */
export function TodayViewTabs({ active, opportunityCount }: { active: TodayView; opportunityCount: number }) {
  const items: { value: TodayView; label: string; href: string }[] = [
    { value: "priority", label: "Priority queue", href: "/today" },
    { value: "by-type", label: `By type${opportunityCount > 0 ? ` (${opportunityCount})` : ""}`, href: "/today?view=by-type" },
  ];

  return (
    <div className="flex gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1 sm:w-fit" role="group" aria-label="Today view">
      {items.map((item) => (
        <Link
          key={item.value}
          href={item.href}
          aria-pressed={active === item.value}
          className={`rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
            active === item.value ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-900"
          }`}
        >
          {item.label}
        </Link>
      ))}
    </div>
  );
}
