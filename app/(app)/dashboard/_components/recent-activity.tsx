import { sectionLabelClass } from "@/lib/ui/typography";
import type { ActivityItem } from "@/lib/dashboard/queries";
import { formatRelativeTime } from "@/lib/dashboard/format";

export function RecentActivity({ items }: { items: ActivityItem[] }) {
  return (
    <div>
      <p className={sectionLabelClass}>Recent activity</p>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No activity yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100">
          {items.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-4 py-2.5">
              <span className="min-w-0 truncate text-sm text-slate-700">{item.message}</span>
              <span className="shrink-0 text-xs tabular-nums text-slate-400">{formatRelativeTime(item.timestamp)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
