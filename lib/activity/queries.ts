import type { SupabaseClient } from "@supabase/supabase-js";

export type ActivityEntry = {
  id: string;
  user_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: unknown;
  created_at: string;
};

export const ACTIVITY_PAGE_SIZE = 50;

export const ACTIVITY_ENTITY_TYPES: { value: string; label: string }[] = [
  { value: "contact", label: "Contact" },
  { value: "lead", label: "Lead" },
  { value: "appointment", label: "Appointment" },
  { value: "conversation", label: "Conversation" },
];

export type ActivitySummary = {
  total: number;
  today: number;
  thisWeek: number;
  systemCount: number;
  userCount: number;
};

function startOfToday(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function startOfWeek(now: Date): Date {
  const start = startOfToday(now);
  start.setDate(start.getDate() - start.getDay());
  return start;
}

/**
 * Real counts only, computed with lightweight `count: "exact", head: true`
 * queries (no rows fetched) so this stays cheap regardless of how large the
 * audit log grows - both indexed by (organization_id, created_at).
 */
export async function getActivitySummary(
  supabase: SupabaseClient,
  organizationId: string,
  now: Date = new Date(),
): Promise<ActivitySummary> {
  const todayIso = startOfToday(now).toISOString();
  const weekIso = startOfWeek(now).toISOString();

  const [totalResult, todayResult, weekResult, systemResult] = await Promise.all([
    supabase.from("audit_log").select("*", { count: "exact", head: true }).eq("organization_id", organizationId),
    supabase
      .from("audit_log")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .gte("created_at", todayIso),
    supabase
      .from("audit_log")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .gte("created_at", weekIso),
    supabase
      .from("audit_log")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .is("user_id", null),
  ]);

  const total = totalResult.count ?? 0;
  const systemCount = systemResult.count ?? 0;

  return {
    total,
    today: todayResult.count ?? 0,
    thisWeek: weekResult.count ?? 0,
    systemCount,
    userCount: total - systemCount,
  };
}

export type ActivityFilters = {
  query?: string;
  entityType?: string;
  from?: string;
  to?: string;
};

export type ActivityPage = {
  entries: ActivityEntry[];
  hasMore: boolean;
};

/**
 * Server-side filtered and paginated - unlike Contacts/Leads (which fetch a
 * capped set and filter in memory because the name search spans separate
 * first/last columns), audit_log's `action`/`entity_type`/`created_at` are
 * plain filterable columns, and the log can grow much larger over time than
 * a contractor's contact list, so real SQL filtering + a limit is the
 * efficient choice here. `metadata` (jsonb, no GIN index) is intentionally
 * excluded from search - an unindexed jsonb scan is not a practical or
 * safe query to run on every keystroke.
 */
export async function getActivityEntries(
  supabase: SupabaseClient,
  organizationId: string,
  filters: ActivityFilters,
  limit: number,
): Promise<ActivityPage> {
  let request = supabase
    .from("audit_log")
    .select("id, user_id, action, entity_type, entity_id, metadata, created_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  if (filters.entityType && filters.entityType !== "all") {
    request = request.eq("entity_type", filters.entityType);
  }

  if (filters.from) {
    request = request.gte("created_at", new Date(`${filters.from}T00:00:00`).toISOString());
  }

  if (filters.to) {
    request = request.lte("created_at", new Date(`${filters.to}T23:59:59.999`).toISOString());
  }

  const term = filters.query?.trim();
  if (term) {
    // PostgREST's `.or()` takes a raw filter-syntax string; strip characters
    // that are structurally significant in that syntax (`,` separates
    // conditions, `()` nests them) so user input can't alter the query's
    // shape - RLS still bounds every result to this organization regardless,
    // but there's no reason to let search text change filter structure.
    const safeTerm = term.replace(/[,()]/g, "");
    if (safeTerm) {
      request = request.or(`action.ilike.%${safeTerm}%,entity_type.ilike.%${safeTerm}%`);
    }
  }

  const { data, error } = await request.range(0, limit);

  if (error) {
    return { entries: [], hasMore: false };
  }

  const rows = (data ?? []) as ActivityEntry[];
  const hasMore = rows.length > limit;
  return { entries: hasMore ? rows.slice(0, limit) : rows, hasMore };
}
