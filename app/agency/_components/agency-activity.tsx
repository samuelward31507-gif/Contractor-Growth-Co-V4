import Link from "next/link";
import { History } from "lucide-react";
import { EmptyState } from "@/lib/ui/empty-state";
import { formatRelativeTime } from "@/lib/dashboard/format";
import type { AgencyActivityItem } from "@/lib/agency/operations";
import { AgencySection } from "./section";

/**
 * Agency Command Center UI review: a genuine cross-client activity feed,
 * built from real per-organization activity (lib/agency/operations.ts's
 * getAgencyRecentActivity, which reuses the client dashboard's own
 * getDashboardData per organization) - never fabricated. An agency with no
 * client activity anywhere gets an honest empty state, not placeholder rows.
 *
 * Agency overview redesign: a card section with edge-to-edge rows; on a
 * phone the time drops under the message instead of squeezing it.
 */
export function AgencyActivity({ items }: { items: AgencyActivityItem[] }) {
  return (
    <AgencySection id="recent-activity" title="Recent activity" description={items.length > 0 ? "Latest events across every client, newest first" : undefined}>
      {items.length === 0 ? (
        <div className="px-4 pb-4 sm:px-5 sm:pb-5">
          <EmptyState icon={History} title="No client activity yet." description="Activity will appear here as client organizations start using Trackpr - new leads, appointments, messages and completed work." />
        </div>
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {items.map((item) => (
            <li key={item.id} className="flex flex-col gap-0.5 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-5">
              <span className="min-w-0 text-sm text-ink-2 sm:truncate">
                <Link
                  href={`/agency/organizations/${item.organizationId}`}
                  className="rounded-sm font-medium text-ink hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  {item.organizationName}
                </Link>{" "}
                <span className="text-ink-3" aria-hidden>
                  ·
                </span>{" "}
                {item.message}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-ink-3">{formatRelativeTime(item.timestamp)}</span>
            </li>
          ))}
        </ul>
      )}
    </AgencySection>
  );
}
