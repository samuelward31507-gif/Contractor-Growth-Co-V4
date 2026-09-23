import Link from "next/link";
import { sectionLabelClass } from "@/lib/ui/typography";
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

function ActivityRow({ entry, currentUserId }: { entry: ActivityEntry; currentUserId: string }) {
  const entityLabel = activityEntityLabel(entry.entity_type);
  const href = activityEntityHref(entry.entity_type, entry.entity_id);
  const metadataDescription = describeMetadata(entry.metadata);
  const actor = describeActor(entry.user_id, currentUserId);
  // A member expression (icons.entry), not a bare PascalCase identifier, so
  // this reads to both JSX and the react-hooks/static-components lint rule
  // as selecting one of a few stable, module-level icon components - never
  // as defining a new component during render.
  const icons = { entry: activityIcon(entry.entity_type) };

  const content = (
    <>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500">
        <icons.entry className="h-4 w-4" aria-hidden />
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
      <Link href={href} className="flex items-start gap-3 rounded-md px-2 py-3 transition-colors hover:bg-slate-50">
        {content}
      </Link>
    );
  }

  return <div className="flex items-start gap-3 px-2 py-3">{content}</div>;
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
      <div className="px-2 py-14 text-center">
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
    <div className="space-y-8">
      {[...groups.entries()].map(([label, items]) => (
        <div key={label}>
          <p className={sectionLabelClass}>{label}</p>
          <div className="mt-3 divide-y divide-slate-100">
            {items.map((entry) => (
              <ActivityRow key={entry.id} entry={entry} currentUserId={currentUserId} />
            ))}
          </div>
        </div>
      ))}

      {hasMore ? (
        <div className="flex justify-center pt-2">
          <Link
            href={loadMoreHref}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
          >
            Load more
          </Link>
        </div>
      ) : null}
    </div>
  );
}
