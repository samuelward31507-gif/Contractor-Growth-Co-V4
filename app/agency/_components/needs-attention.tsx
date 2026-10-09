import Link from "next/link";
import { AlertCircle, AlertTriangle, CheckCircle2, ChevronRight } from "lucide-react";
import { EmptyState } from "@/lib/ui/empty-state";
import { formatRelativeTime } from "@/lib/dashboard/format";
import type { NeedsAttentionCategory, NeedsAttentionItem } from "@/lib/agency/needs-attention";
import { AgencySection } from "./section";

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
  const critical = item.severity === "critical";
  return (
    <li>
      <Link
        href={item.actionHref}
        className={`group flex min-h-12 items-center gap-3 border-l-2 py-3 pl-3.5 pr-4 transition-colors hover:bg-hover focus:outline-none focus-visible:inset-ring-2 focus-visible:inset-ring-accent/40 sm:pl-[18px] sm:pr-5 ${
          critical ? "border-l-danger" : "border-l-warning"
        }`}
      >
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${critical ? "bg-danger-muted text-danger" : "bg-warning-muted text-warning"}`}>
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate text-sm font-medium text-ink">
              {item.problem} <span className="font-normal text-ink-3">— {item.organizationName}</span>
            </span>
            <span className="shrink-0 text-xs tabular-nums text-ink-3">{formatRelativeTime(item.timestamp)}</span>
          </span>
          <span className="mt-0.5 block truncate text-xs text-ink-3">
            <span className="sr-only">{critical ? "Critical. " : "Warning. "}</span>
            {item.why}
          </span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-ink-4 transition-colors group-hover:text-ink-3" aria-hidden />
      </Link>
    </li>
  );
}

/**
 * Agency Command Center 2.0 - the dominant section on the page. Every item
 * comes from lib/agency/needs-attention.ts, which only ever surfaces real,
 * derivable operational conditions - nothing is computed, scored, or
 * invented here.
 *
 * Trackpr 2.0 Phase 6: grouped by category (Billing/Automation/Onboarding/
 * Communication/System health) rather than one flat list - a group with at
 * least one critical item sorts first, so a genuinely urgent issue never
 * gets buried under a longer but less severe category; items within each
 * group keep their existing severity-then-recency order from
 * getAgencyNeedsAttentionItems. This is purely a display grouping - no
 * severity, ranking, or score is computed here.
 *
 * Agency overview redesign: one card section in the client app's idiom
 * (AgencySection), each row a full-width link with a severity rail (danger =
 * critical, warning = warning) and the severity also stated in words for
 * screen readers - never colour alone. `partialData` keeps an empty feed
 * honest: when a read behind it failed, "nothing found" is not "all clear".
 */
export function NeedsAttention({ items, partialData = false }: { items: NeedsAttentionItem[]; partialData?: boolean }) {
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
    <AgencySection
      id="needs-attention"
      title="Needs your attention"
      description={items.length > 0 ? "Open issues across your clients · critical groups first" : undefined}
      count={items.length > 0 ? items.length : undefined}
    >
      {items.length === 0 ? (
        <div className="px-4 pb-4 sm:px-5 sm:pb-5">
          {partialData ? (
            <EmptyState
              icon={AlertCircle}
              title="No open issues found, but this list may be incomplete."
              description="Some client data couldn't be read just now, so an issue could be missing here. Reload the page to check again."
            />
          ) : (
            <EmptyState
              icon={CheckCircle2}
              title="All clients are operating normally."
              description="Nothing needs your attention right now. Billing, automation, onboarding, communication and system issues will appear here first."
            />
          )}
        </div>
      ) : (
        <div className="pb-1.5">
          {groups.map((category) => {
            const categoryItems = byCategory.get(category)!;
            const headingId = `needs-attention-${category}`;
            return (
              <div key={category} className="border-t border-line">
                <h3 id={headingId} className="px-4 pb-1 pt-3 text-xs font-medium text-ink-3 sm:px-5">
                  {CATEGORY_LABEL[category]} <span className="text-ink-4">· {categoryItems.length}</span>
                </h3>
                <ul aria-labelledby={headingId} className="divide-y divide-line">
                  {categoryItems.map((item) => (
                    <ItemRow key={item.id} item={item} />
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </AgencySection>
  );
}
