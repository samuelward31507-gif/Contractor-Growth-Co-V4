import Link from "next/link";
import { segmentedItemClass, segmentedTrackClass } from "@/lib/ui/segmented";

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
    <div className={segmentedTrackClass} role="group" aria-label="Money view">
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
