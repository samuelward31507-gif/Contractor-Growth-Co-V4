import { sectionLabelClass, metaClass } from "@/lib/ui/typography";
import { formatMoney } from "./format";
import { formatRelativeTime } from "@/lib/dashboard/format";
import type { RevenueEventRecord } from "@/lib/agency/revenue";

const EVENT_TYPE_LABEL: Record<RevenueEventRecord["eventType"], string> = {
  payment_succeeded: "Payment collected",
  payment_failed: "Payment failed",
  refund: "Refund",
};

const EVENT_TYPE_TONE: Record<RevenueEventRecord["eventType"], string> = {
  payment_succeeded: "text-accent-text",
  payment_failed: "text-red-600",
  refund: "text-amber-600",
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
 * elsewhere on the page (see RevenueSummary/ClientRevenueTable, both
 * computed from the full, uncapped query result).
 */
export function RecentRevenueEvents({ events }: { events: RevenueEventRecord[] }) {
  return (
    <div className="mt-8 border-t border-slate-200 pt-8">
      <div className="flex items-baseline justify-between">
        <p className={sectionLabelClass}>Recent revenue events</p>
        {events.length > 0 ? <span className={metaClass}>Most recent {events.length}</span> : null}
      </div>

      {events.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No revenue events recorded in this period.</p>
      ) : (
        <div className="mt-2 divide-y divide-slate-100">
          {events.map((event) => (
            <div key={event.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm text-slate-800">
                  <span className={`font-medium ${EVENT_TYPE_TONE[event.eventType]}`}>{EVENT_TYPE_LABEL[event.eventType]}</span>
                  <span className="text-slate-400"> · {categoryLabel(event.revenueCategory)}</span>
                </p>
                <p className="truncate text-xs text-slate-500">{event.organizationName}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-sm font-semibold tabular-nums text-slate-900">{formatMoney(event.amount, event.currency)}</p>
                <p className="text-xs text-slate-400">{formatRelativeTime(event.occurredAt)}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
