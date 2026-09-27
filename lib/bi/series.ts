import type { SupabaseClient } from "@supabase/supabase-js";

const MAX_ROWS = 10_000;
/** Safety bound on the number of day buckets a single call can produce - matches this file's own "cap, don't remove" convention (see lib/bi/queries.ts's MAX_ROWS comment). A caller should never need more than a year of daily buckets in one chart. */
const MAX_BUCKETS = 366;

export type DailyCount = { date: string; count: number };

/** `YYYY-MM-DD` in the server process's local time - the same local-time convention lib/bi/queries.ts's resolveDateRange already uses for its day boundaries, so a bucket's date always matches the calendar day that produced its ISO boundary. */
function toLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Every local calendar day from `fromIso` (inclusive) up to `toIso`
 * (exclusive), as plain `YYYY-MM-DD` keys - a pure function, unit-tested
 * directly (lib/bi/series.test.ts), independent of any query. Both bounds
 * must be real ISO timestamps (never null/"all time") - the caller resolves
 * an unbounded range to a concrete window first (see the Trend chart's own
 * page-level comment for why), so this function never has to guess how far
 * back to go.
 */
export function buildDayBuckets(fromIso: string, toIso: string): string[] {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  const buckets: string[] = [];
  const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  while (cursor < end && buckets.length < MAX_BUCKETS) {
    buckets.push(toLocalDateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return buckets;
}

export type DailyCountSeries = { data: DailyCount[]; failed: boolean };

/**
 * Phase 6 (Trend chart pass): the plan's own one new query for this whole
 * redesign - every other phase reused an existing read. Counts leads by the
 * local calendar day they were created on, over `[from, to)` - the exact
 * half-open convention lib/bi/queries.ts's resolveDateRange already
 * documents. A single narrow-column, org-scoped, range-scoped SELECT
 * (leads.created_at only), reduced to day buckets in memory - the same
 * "fetch once, derive everything" strategy every other lib/bi query already
 * uses (see lib/bi/queries.ts's own file-level comment), never a query per
 * day. "New leads per day" - not a dollar figure - is deliberately the
 * metric: it's vertical-neutral (both contractor and gym orgs have leads)
 * and carries none of lib/bi/types.ts's "never call anything revenue"
 * caveats a dollar-based trend would need to repeat.
 */
export async function getLeadsCreatedPerDay(
  supabase: SupabaseClient,
  organizationId: string,
  range: { from: string; to: string },
): Promise<DailyCountSeries> {
  const { data, error } = await supabase
    .from("leads")
    .select("created_at")
    .eq("organization_id", organizationId)
    .gte("created_at", range.from)
    .lt("created_at", range.to)
    .limit(MAX_ROWS);

  if (error) {
    return { data: [], failed: true };
  }

  const buckets = buildDayBuckets(range.from, range.to);
  const counts = new Map(buckets.map((date) => [date, 0]));

  for (const row of data ?? []) {
    const key = toLocalDateKey(new Date(row.created_at));
    if (counts.has(key)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  return { data: buckets.map((date) => ({ date, count: counts.get(date) ?? 0 })), failed: false };
}
