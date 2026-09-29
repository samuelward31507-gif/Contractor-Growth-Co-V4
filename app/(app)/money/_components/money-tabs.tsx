import Link from "next/link";

export type MoneyTab = "money" | "invoices" | "estimates" | "jobs";

/**
 * IA consolidation pass: Work's own three tabs (Needs to move | Estimates |
 * Jobs) collapse into this one - "Money" is the new default curated view
 * (Quotes out / Ready to schedule / Won not finished, replacing Needs to
 * move), and "All estimates"/"All jobs" are Work's own full browse-and-
 * search tables, unchanged, just reached from here instead of /work. Same
 * segmented-control pattern WorkTabs itself established.
 *
 * Phase 1B-3: "Invoices" joins the set - the billing side of the same
 * money-in-motion story, backed by public.invoices and
 * public.customer_payments.
 */
export function MoneyTabs({ active }: { active: MoneyTab }) {
  const items: { value: MoneyTab; label: string; href: string }[] = [
    { value: "money", label: "Money", href: "/money" },
    { value: "invoices", label: "Invoices", href: "/money?browse=invoices" },
    { value: "estimates", label: "All estimates", href: "/money?browse=estimates" },
    { value: "jobs", label: "All jobs", href: "/money?browse=jobs" },
  ];

  return (
    <div className="inline-flex gap-0.5 rounded-md bg-inset p-0.5" role="group" aria-label="Money view">
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
