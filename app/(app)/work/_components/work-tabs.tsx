import Link from "next/link";

export type WorkTab = "needs-to-move" | "estimates" | "jobs";

/**
 * Usability audit fix (#5, Work real tabs): a real segmented control - same
 * visual language as Schedule's Day/Week/Month/List switcher and
 * Appointments' Upcoming/Today/Past tabs (rounded-lg border bg-slate-50 p-1,
 * pressed segment gets bg-white shadow-sm) - replacing the old plain "View
 * jobs" text link that swapped the entire page identity (different title,
 * description, badge). All three tabs now render under the exact same
 * "Estimates & Jobs" header, so switching feels like changing a view of one
 * workspace rather than navigating to a different page.
 */
export function WorkTabs({ active, needsToMoveCount }: { active: WorkTab; needsToMoveCount: number }) {
  const items: { value: WorkTab; label: string; href: string }[] = [
    { value: "needs-to-move", label: `Needs to move${needsToMoveCount > 0 ? ` (${needsToMoveCount})` : ""}`, href: "/work" },
    { value: "estimates", label: "Estimates", href: "/work?type=estimates" },
    { value: "jobs", label: "Jobs", href: "/work?type=jobs" },
  ];

  return (
    <div className="flex gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1 sm:w-fit" role="group" aria-label="Work view">
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
