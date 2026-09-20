import Link from "next/link";
import { sectionLabelClass } from "@/lib/ui/typography";
import { formatRelativeTime } from "@/lib/dashboard/format";
import type { AgencyActivityItem } from "@/lib/agency/operations";

/**
 * Agency Command Center UI review: a genuine cross-client activity feed,
 * built from real per-organization activity (lib/agency/operations.ts's
 * getAgencyRecentActivity, which reuses the client dashboard's own
 * getDashboardData per organization) - never fabricated. An agency with no
 * client activity anywhere gets an honest empty state, not placeholder rows.
 */
export function AgencyActivity({ items }: { items: AgencyActivityItem[] }) {
  return (
    <div>
      <p className={sectionLabelClass}>Recent activity</p>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">Activity will appear here as client organizations start using Trackpr.</p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100">
          {items.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-4 py-2.5">
              <span className="min-w-0 truncate text-sm text-slate-700">
                <Link href={`/agency/organizations/${item.organizationId}`} className="font-medium text-slate-900 hover:underline">
                  {item.organizationName}
                </Link>{" "}
                <span className="text-slate-400">·</span> {item.message}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-slate-400">{formatRelativeTime(item.timestamp)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
