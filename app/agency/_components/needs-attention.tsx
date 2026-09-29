import Link from "next/link";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { surfaceClass } from "@/lib/ui/surface";
import { primarySectionTitleClass, metaClass } from "@/lib/ui/typography";
import { formatRelativeTime } from "@/lib/dashboard/format";
import type { NeedsAttentionCategory, NeedsAttentionItem } from "@/lib/agency/needs-attention";

const CATEGORY_LABEL: Record<NeedsAttentionCategory, string> = {
  billing: "Billing",
  automation: "Automation",
  onboarding: "Onboarding",
  communication: "Communication",
  system: "System health",
};

/** Display order when no group has a critical item to promote it - matches the phase brief's own example ordering. */
const CATEGORY_ORDER: NeedsAttentionCategory[] = ["billing", "automation", "onboarding", "communication", "system"];

function ItemRow({ item }: { item: NeedsAttentionItem }) {
  return (
    <Link
      key={item.id}
      href={item.actionHref}
      className="group -mx-2 flex items-center gap-3 rounded-md px-2 py-3 transition-colors hover:bg-hover"
    >
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
          item.severity === "critical" ? "bg-danger-muted text-danger" : "bg-warning-muted text-warning"
        }`}
      >
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-ink">
            {item.problem} <span className="text-ink-3">— {item.organizationName}</span>
          </span>
          <span className="shrink-0 text-xs tabular-nums text-ink-3">{formatRelativeTime(item.timestamp)}</span>
        </span>
        <span className="block truncate text-xs text-ink-3">{item.why}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-ink-4 transition-colors group-hover:text-ink-3" aria-hidden />
    </Link>
  );
}

/**
 * Agency Command Center 2.0 - the dominant section on the page, mirroring
 * app/(app)/dashboard/_components/attention-panel.tsx's exact treatment (a
 * real heading, not a receding label; rows flush on the canvas with divider
 * lines, not inside a bordered/tinted card; a confirmed-healthy empty state
 * gets the one distinct surface on the page). Every item comes from
 * lib/agency/needs-attention.ts, which only ever surfaces real, derivable
 * operational conditions - nothing is computed, scored, or invented here.
 *
 * Trackpr 2.0 Phase 6: grouped by category (Billing/Automation/Onboarding/
 * Communication/System health) rather than one flat list - a group with at
 * least one critical item sorts first, so a genuinely urgent issue never
 * gets buried under a longer but less severe category; items within each
 * group keep their existing severity-then-recency order from
 * getAgencyNeedsAttentionItems. This is purely a display grouping - no
 * severity, ranking, or score is computed here.
 */
export function NeedsAttention({ items }: { items: NeedsAttentionItem[] }) {
  const byCategory = new Map<NeedsAttentionCategory, NeedsAttentionItem[]>();
  for (const item of items) {
    const list = byCategory.get(item.category) ?? [];
    list.push(item);
    byCategory.set(item.category, list);
  }

  const groups = CATEGORY_ORDER.filter((category) => byCategory.has(category)).sort((a, b) => {
    const aCritical = byCategory.get(a)!.some((item) => item.severity === "critical");
    const bCritical = byCategory.get(b)!.some((item) => item.severity === "critical");
    if (aCritical !== bCritical) return aCritical ? -1 : 1;
    return 0;
  });

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h2 className={primarySectionTitleClass}>Needs your attention</h2>
        {items.length > 0 ? <span className={metaClass}>{items.length}</span> : null}
      </div>

      {items.length === 0 ? (
        <div className={`${surfaceClass} mt-5 px-6 py-14 text-center`}>
          <p className="text-base font-medium text-ink">All clients are operating normally.</p>
          <p className="mt-1.5 text-sm text-ink-3">Nothing needs your attention right now.</p>
        </div>
      ) : (
        <div className="mt-5 flex flex-col gap-6">
          {groups.map((category) => {
            const categoryItems = byCategory.get(category)!;
            return (
              <div key={category}>
                <p className="text-xs font-medium text-ink-3">
                  {CATEGORY_LABEL[category]} <span className="text-ink-4">· {categoryItems.length}</span>
                </p>
                <div className="mt-1 divide-y divide-line">
                  {categoryItems.map((item) => (
                    <ItemRow key={item.id} item={item} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
