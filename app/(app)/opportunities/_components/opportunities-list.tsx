import Link from "next/link";
import { ArrowRight, Target, AlertCircle } from "lucide-react";
import { EmptyState } from "@/lib/ui/empty-state";
import { RAIL_TONE_CLASS, type BadgeTone } from "@/lib/ui/badge";
import { sectionLabelClass, metaClass } from "@/lib/ui/typography";
import { formatCurrency } from "@/lib/dashboard/format";
import type { Opportunity, OpportunityType } from "@/lib/opportunities/queries";
import { DismissOpportunityButton } from "../../dashboard/_components/dismiss-opportunity-button";
import {
  OPPORTUNITY_TYPE_ORDER,
  OPPORTUNITY_TYPE_LABEL,
  OPPORTUNITY_TYPE_ICON,
  OPPORTUNITY_TYPE_TONE,
  OPPORTUNITY_ACTION_LABEL,
  opportunityActionHref,
} from "./opportunity-type";

/** Mirrors lib/ui/badge.tsx's own light-surface TONE_CLASS exactly (not exported there) - the same icon-chip background/text pairing every other tone-driven icon chip in this app already uses. */
const OPPORTUNITY_TYPE_STYLE: Record<BadgeTone, string> = {
  neutral: "bg-slate-100 text-slate-600",
  info: "bg-blue-50 text-blue-600",
  success: "bg-accent-muted text-accent-text",
  warning: "bg-warning-muted text-warning-text",
  danger: "bg-danger-muted text-danger-text",
};

/**
 * Trackpr 2.0, Phase 3F: one opportunity row. Deliberately not a single
 * wrapping <Link> (the pattern every other list page in this app uses) -
 * an opportunity genuinely has up to three distinct destinations (the
 * customer, the type-specific action target, and the dismiss control), and
 * nesting a button inside an anchor is its own real accessibility problem -
 * so this mirrors AttentionPanel's own established shape instead: a plain
 * row with the customer/context/description as the leading content and
 * every real action as an explicit, separate, keyboard-reachable control.
 */
function OpportunityRow({ opportunity }: { opportunity: Opportunity }) {
  const Icon = OPPORTUNITY_TYPE_ICON[opportunity.type];
  const tone = OPPORTUNITY_TYPE_TONE[opportunity.type];
  const actionHref = opportunityActionHref(opportunity);
  const actionLabel = OPPORTUNITY_ACTION_LABEL[opportunity.type];

  return (
    <li className={`flex flex-col gap-3 border-l-2 py-4 pl-3 pr-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4 ${RAIL_TONE_CLASS[tone]}`}>
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${OPPORTUNITY_TYPE_STYLE[tone]}`}>
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900">{opportunity.title}</p>
          {opportunity.description ? <p className="mt-0.5 text-sm text-slate-500">{opportunity.description}</p> : null}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            {opportunity.estimatedValue != null ? (
              <span className="text-sm font-semibold tabular-nums text-slate-700">{formatCurrency(opportunity.estimatedValue)}</span>
            ) : (
              <span className={metaClass}>Unknown value</span>
            )}
            {opportunity.contactId ? (
              <Link
                href={`/customers/${opportunity.contactId}`}
                className="rounded text-xs font-medium text-slate-500 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                View customer
              </Link>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 self-start sm:flex-col sm:items-end">
        <Link
          href={actionHref}
          className="inline-flex items-center gap-1 rounded text-sm font-medium text-slate-600 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          {actionLabel}
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
        <DismissOpportunityButton opportunityId={opportunity.id} />
      </div>
    </li>
  );
}

export function OpportunitiesList({ opportunities, failed }: { opportunities: Opportunity[]; failed: boolean }) {
  // Trackpr 2.0, Phase 4B (P1 #5): a real query failure must never render as
  // "You're all caught up." - see getOpenOpportunitiesResult's own comment
  // in lib/opportunities/queries.ts. Checked before the genuine-emptiness
  // branch below since a failed read also comes back as an empty array.
  if (failed) {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Opportunities couldn't be loaded."
        description="Some information is temporarily unavailable. Please try again."
      />
    );
  }

  if (opportunities.length === 0) {
    return (
      <EmptyState
        icon={Target}
        title="You're all caught up."
        description="No open opportunities right now - Trackpr will surface a new one here the moment it detects something worth a look."
      />
    );
  }

  const byType = new Map<OpportunityType, Opportunity[]>();
  for (const opportunity of opportunities) {
    const list = byType.get(opportunity.type) ?? [];
    list.push(opportunity);
    byType.set(opportunity.type, list);
  }

  const groups = OPPORTUNITY_TYPE_ORDER.map((type) => ({ type, items: byType.get(type) ?? [] })).filter((group) => group.items.length > 0);

  return (
    <div className="flex flex-col gap-8">
      {groups.map(({ type, items }) => (
        <div key={type}>
          <div className="flex items-baseline justify-between">
            <p className={sectionLabelClass}>{OPPORTUNITY_TYPE_LABEL[type]}</p>
            <span className={metaClass}>{items.length}</span>
          </div>
          <ul className="mt-2 divide-y divide-slate-100">
            {items.map((opportunity) => (
              <OpportunityRow key={opportunity.id} opportunity={opportunity} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
