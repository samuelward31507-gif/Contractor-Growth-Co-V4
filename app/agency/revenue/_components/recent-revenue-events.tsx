import { AlertCircle, Receipt } from "lucide-react";
import { SectionCard } from "@/lib/ui/section-card";
import { EmptyState } from "@/lib/ui/empty-state";
import { Badge, type BadgeTone } from "@/lib/ui/badge";
import { formatMoney } from "./format";
import { formatRelativeTime } from "@/lib/dashboard/format";
import type { RevenueEventRecord } from "@/lib/agency/revenue";

const EVENT_TYPE_LABEL: Record<RevenueEventRecord["eventType"], string> = {
  payment_succeeded: "Payment collected",
  payment_failed: "Payment failed",
  refund: "Refund",
};

const EVENT_TYPE_TONE: Record<RevenueEventRecord["eventType"], BadgeTone> = {
  payment_succeeded: "success",
  payment_failed: "danger",
  refund: "warning",
};

function categoryLabel(category: RevenueEventRecord["revenueCategory"]): string {
  if (category === "setup") return "Setup";
  if (category === "recurring") return "Recurring";
  return "Uncategorized";
}

/**
 * Trackpr Phase 5D-1 - Recent Revenue Events. A flat chronological list
 * (most recent first, capped at MAX_RECENT_EVENTS in lib/agency/revenue.ts) -
 * this is a display list only, never itself the basis for any total shown
 * elsewhere on the page (see RevenueHeadline/ClientRevenueTable, both
 * computed from the full, uncapped query result).
 *
 * Agency redesign: a SectionCard with the event type as a shared Badge. When
 * the revenue read failed the list is empty because nothing loaded - that
 * case says so instead of claiming no events were recorded.
 */
export function RecentRevenueEvents({ events, unavailable }: { events: RevenueEventRecord[]; unavailable: boolean }) {
  return (
    <SectionCard
      title="Recent revenue events"
      description="Each Stripe payment, failure and refund as it was recorded, newest first."
      action={events.length > 0 ? <span className="shrink-0 text-xs text-ink-3">Most recent {events.length}</span> : undefined}
    >
      {unavailable ? (
        <EmptyState icon={AlertCircle} title="Revenue events couldn't be loaded" description="The event list for this period is unavailable right now. Please try again shortly." />
      ) : events.length === 0 ? (
        <EmptyState icon={Receipt} title="No revenue events in this period" description="No Stripe payment, failure or refund was recorded for this period. Events appear here as Stripe reports them." />
      ) : (
        <ul className="divide-y divide-line">
          {events.map((event) => (
            <li key={event.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink">
                  <Badge tone={EVENT_TYPE_TONE[event.eventType]}>{EVENT_TYPE_LABEL[event.eventType]}</Badge>
                  <span className="text-xs text-ink-3">{categoryLabel(event.revenueCategory)}</span>
                </p>
                <p className="mt-1 truncate text-xs text-ink-3">{event.organizationName}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-sm font-semibold tabular-nums text-ink">{formatMoney(event.amount, event.currency)}</p>
                <p className="text-xs text-ink-3">
                  <time dateTime={event.occurredAt}>{formatRelativeTime(event.occurredAt)}</time>
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
