import Link from "next/link";

export type MoneyTab = "money" | "estimates" | "jobs";

/**
 * IA consolidation pass: Work's own three tabs (Needs to move | Estimates |
 * Jobs) collapse into this one - "Money" is the new default curated view
 * (Quotes out / Ready to schedule / Won not finished, replacing Needs to
 * move), and "All estimates"/"All jobs" are Work's own full browse-and-
 * search tables, unchanged, just reached from here instead of /work. Same
 * segmented-control pattern WorkTabs itself established.
 */
export function MoneyTabs({ active }: { active: MoneyTab }) {
  const items: { value: MoneyTab; label: string; href: string }[] = [
    { value: "money", label: "Money", href: "/money" },
    { value: "estimates", label: "All estimates", href: "/money?browse=estimates" },
    { value: "jobs", label: "All jobs", href: "/money?browse=jobs" },
  ];

  return (
    <div className="flex gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1 sm:w-fit" role="group" aria-label="Money view">
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
