import Link from "next/link";
import { cardClass, cardHeaderClass, cardSubtleClass, cardTitleClass } from "@/lib/ui/card";
import type { AttentionItem } from "@/lib/dashboard/queries";
import { Icon, type IconName } from "../../_components/icon";

const KIND_ICON: Record<AttentionItem["kind"], IconName> = {
  overdue_appointment: "clock",
  hot_lead: "flame",
  pending_estimate: "document",
};

const KIND_STYLE: Record<AttentionItem["kind"], string> = {
  overdue_appointment: "bg-amber-50 text-amber-600",
  hot_lead: "bg-red-50 text-red-600",
  pending_estimate: "bg-blue-50 text-blue-600",
};

export function AttentionPanel({ items }: { items: AttentionItem[] }) {
  return (
    <div className={cardClass}>
      <div className={cardHeaderClass}>
        <h2 className={cardTitleClass}>Needs Attention</h2>
      </div>
      {items.length === 0 ? (
        <div className="px-5 py-10 text-center">
          <p className="text-sm font-medium text-slate-900">You&apos;re all caught up.</p>
          <p className={`mt-1 ${cardSubtleClass}`}>Nothing needs your attention right now.</p>
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {items.map((item) => (
            <li key={item.id}>
              <Link
                href={item.href}
                className="flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-slate-50"
              >
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${KIND_STYLE[item.kind]}`}>
                  <Icon name={KIND_ICON[item.kind]} className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-slate-900">{item.title}</span>
                  <span className={`block truncate ${cardSubtleClass}`}>{item.detail}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
