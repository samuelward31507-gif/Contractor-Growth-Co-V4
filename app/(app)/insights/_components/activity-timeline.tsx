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

function ActivityRow({ entry, currentUserId, timeZone }: { entry: ActivityEntry; currentUserId: string; timeZone?: string }) {
  const entityLabel = activityEntityLabel(entry.entity_type);
  const href = activityEntityHref(entry.entity_type, entry.entity_id, entry.metadata);
  const metadataDescription = describeMetadata(entry.metadata);
  const actor = describeActor(entry.user_id, currentUserId);
  // A member expression (icons.entry), not a bare PascalCase identifier, so
  // this reads to both JSX and the react-hooks/static-components lint rule
  // as selecting one of a few stable, module-level icon components - never
  // as defining a new component during render.
  const icons = { entry: activityIcon(entry.entity_type) };

  const content = (
    <>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-inset text-ink-3">
        <icons.entry className="h-4 w-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium text-ink">{humanizeText(entry.action)}</span>
          {entityLabel ? <span className="text-xs text-ink-3">· {entityLabel}</span> : null}
        </span>
        {metadataDescription ? (
          <span className="mt-0.5 block truncate text-xs text-ink-3">{metadataDescription}</span>
        ) : null}
        <span className="mt-1 flex items-center gap-2 text-xs text-ink-3">
          <span>{actor}</span>
          <span aria-hidden>·</span>
          <span>{formatActivityTime(entry.created_at, timeZone)}</span>
        </span>
      </span>
    </>
  );

  if (href) {
    return (
      <Link href={href} className="flex items-start gap-3 rounded-md px-2 py-3 transition-colors hover:bg-hover">
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
  timeZone,
}: {
  entries: ActivityEntry[];
  currentUserId: string;
  hasActiveFilters: boolean;
  hasMore: boolean;
  loadMoreHref: string;
  /** Phase 2A: the organization's timezone - day headings and times are in its calendar, not the server's. */
  timeZone?: string;
}) {
  if (entries.length === 0) {
    return (
      <div className="px-2 py-14 text-center">
        <p className="text-sm font-medium text-ink">No activity matches your filters.</p>
        {hasActiveFilters ? (
          <p className="mt-1 text-sm text-ink-3">Try a different search term or clear your filters.</p>
        ) : null}
      </div>
    );
  }

  const groups = new Map<string, ActivityEntry[]>();
  for (const entry of entries) {
    const label = getActivityDayLabel(entry.created_at, new Date(), timeZone);
    const existing = groups.get(label) ?? [];
    existing.push(entry);
    groups.set(label, existing);
  }

  return (
    <div className="space-y-8">
      {[...groups.entries()].map(([label, items]) => (
        <div key={label}>
          <p className={sectionLabelClass}>{label}</p>
          <div className="mt-3 divide-y divide-line">
            {items.map((entry) => (
              <ActivityRow key={entry.id} entry={entry} currentUserId={currentUserId} timeZone={timeZone} />
            ))}
          </div>
        </div>
      ))}

      {hasMore ? (
        <div className="flex justify-center pt-2">
          <Link
            href={loadMoreHref}
            className="rounded-md border border-line-strong px-4 py-2 text-sm font-medium text-ink-2 transition-colors hover:bg-hover"
          >
            Load more
          </Link>
        </div>
      ) : null}
    </div>
  );
}
