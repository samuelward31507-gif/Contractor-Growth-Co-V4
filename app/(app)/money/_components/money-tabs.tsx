import Link from "next/link";
import { segmentedItemClass, segmentedTrackClass } from "@/lib/ui/segmented";
import { MONEY_TABS, type MoneyTab } from "./money-views";

export { normalizeBrowse, type MoneyTab } from "./money-views";

/**
 * IA consolidation pass: Work's own three tabs (Needs to move | Estimates |
 * Jobs) collapsed into this one; Phase 1B-3 added Invoices; Batch 2 added
 * Payments and made these Money's views (see money-views.ts).
 */
export function MoneyTabs({ active }: { active: MoneyTab }) {
  return (
    <div className={segmentedTrackClass} role="group" aria-label="Money view">
      {MONEY_TABS.map((item) => (
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
