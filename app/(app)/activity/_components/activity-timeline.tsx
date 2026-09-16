import Link from "next/link";
import { cardClass } from "@/lib/ui/card";
import {
  activityEntityHref,
  activityEntityLabel,
  activityIcon,
  describeActor,
  describeMetadata,
  formatActivityTime,
  getActivityDayLabel,
  humanizeText,
} from "@/lib/activity/format";
import type { ActivityEntry } from "@/lib/activity/queries";
import { Icon } from "../../_components/icon";

function ActivityRow({ entry, currentUserId }: { entry: ActivityEntry; currentUserId: string }) {
  const entityLabel = activityEntityLabel(entry.entity_type);
  const href = activityEntityHref(entry.entity_type, entry.entity_id);
  const metadataDescription = describeMetadata(entry.metadata);
  const actor = describeActor(entry.user_id, currentUserId);

  const content = (
    <>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500">
        <Icon name={activityIcon(entry.entity_type)} className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium text-slate-900">{humanizeText(entry.action)}</span>
          {entityLabel ? <span className="text-xs text-slate-400">· {entityLabel}</span> : null}
        </span>
        {metadataDescription ? (
          <span className="mt-0.5 block truncate text-xs text-slate-500">{metadataDescription}</span>
        ) : null}
        <span className="mt-1 flex items-center gap-2 text-xs text-slate-400">
          <span>{actor}</span>
          <span aria-hidden>·</span>
          <span>{formatActivityTime(entry.created_at)}</span>
        </span>
      </span>
    </>
  );

  if (href) {
    return (
      <Link href={href} className="flex items-start gap-3 px-4 py-3.5 transition-colors hover:bg-slate-50 sm:px-5">
        {content}
      </Link>
    );
  }

  return <div className="flex items-start gap-3 px-4 py-3.5 sm:px-5">{content}</div>;
}

export function ActivityTimeline({
  entries,
  currentUserId,
  hasActiveFilters,
  hasMore,
  loadMoreHref,
}: {
  entries: ActivityEntry[];
  currentUserId: string;
  hasActiveFilters: boolean;
  hasMore: boolean;
  loadMoreHref: string;
}) {
  if (entries.length === 0) {
    return (
      <div className={`${cardClass} px-5 py-12 text-center`}>
        <p className="text-sm font-medium text-slate-900">No activity matches your filters.</p>
        {hasActiveFilters ? (
          <p className="mt-1 text-sm text-slate-500">Try a different search term or clear your filters.</p>
        ) : null}
      </div>
    );
  }

  const groups = new Map<string, ActivityEntry[]>();
  for (const entry of entries) {
    const label = getActivityDayLabel(entry.created_at);
    const existing = groups.get(label) ?? [];
    existing.push(entry);
    groups.set(label, existing);
  }

  return (
    <div className="space-y-6">
      {[...groups.entries()].map(([label, items]) => (
        <div key={label}>
          <h3 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</h3>
          <div className={cardClass}>
            <div className="divide-y divide-slate-100">
              {items.map((entry) => (
                <ActivityRow key={entry.id} entry={entry} currentUserId={currentUserId} />
              ))}
            </div>
          </div>
        </div>
      ))}

      {hasMore ? (
        <div className="flex justify-center">
          <Link
            href={loadMoreHref}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
          >
            Load more
          </Link>
        </div>
      ) : null}
    </div>
  );
}
