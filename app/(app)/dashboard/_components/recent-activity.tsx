import { cardClass, cardHeaderClass, cardSubtleClass, cardTitleClass } from "@/lib/ui/card";
import type { ActivityItem } from "@/lib/dashboard/queries";
import { formatRelativeTime } from "@/lib/dashboard/format";

export function RecentActivity({ items }: { items: ActivityItem[] }) {
  return (
    <div className={cardClass}>
      <div className={cardHeaderClass}>
        <h2 className={cardTitleClass}>Recent Activity</h2>
      </div>
      {items.length === 0 ? (
        <div className="px-5 py-10 text-center">
          <p className={`${cardSubtleClass} text-sm`}>No activity yet.</p>
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {items.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-4 px-5 py-3.5">
              <span className="min-w-0 truncate text-sm text-slate-700">{item.message}</span>
              <span className="shrink-0 text-xs text-slate-400">{formatRelativeTime(item.timestamp)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
