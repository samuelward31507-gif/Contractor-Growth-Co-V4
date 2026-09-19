import type { SupabaseClient } from "@supabase/supabase-js";
import { mapIncidentRow, type AutomationIncident, type AutomationIncidentRow, type IncidentSeverity, type IncidentStatus } from "./types";

/**
 * Read layer for automation_incidents - server-only, RLS-scoped by the
 * caller's own session client exactly like every other query module in this
 * codebase (see lib/automation/queries.ts's own precedent). No organization
 * id is ever trusted beyond what is_org_member's RLS policy already grants;
 * callers pass an already-authenticated Supabase client.
 */

const MAX_INCIDENT_ROWS = 200;
const INCIDENT_COLUMNS =
  "id, organization_id, automation_id, workflow_execution_id, category, severity, status, fingerprint, title, description, first_seen_at, last_seen_at, occurrence_count, resolved_at, resolved_by, acknowledged_at, acknowledged_by, metadata, created_at, updated_at";

export type ListIncidentsFilter = {
  status?: IncidentStatus[];
  severity?: IncidentSeverity[];
};

/**
 * Bounded, ordered read of an organization's incidents - most severe and
 * most recently updated first, so the UI's default view surfaces what
 * matters without a second client-side sort. MAX_INCIDENT_ROWS caps a single
 * query rather than ever scanning the full table.
 */
export async function listIncidents(supabase: SupabaseClient, organizationId: string, filter: ListIncidentsFilter = {}): Promise<AutomationIncident[]> {
  let query = supabase.from("automation_incidents").select(INCIDENT_COLUMNS).eq("organization_id", organizationId);

  if (filter.status && filter.status.length > 0) {
    query = query.in("status", filter.status);
  }
  if (filter.severity && filter.severity.length > 0) {
    query = query.in("severity", filter.severity);
  }

  // Fetched in a stable DB order (most recently updated first) and re-sorted
  // by severity in memory below - 'critical' < 'info' < 'warning'
  // alphabetically, so the DB's own text ordering is not a meaningful
  // severity sort.
  const { data, error } = await query.order("updated_at", { ascending: false }).limit(MAX_INCIDENT_ROWS);

  if (error || !data) return [];
  const rows = (data as AutomationIncidentRow[]).map(mapIncidentRow);
  return rows.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.updatedAt.localeCompare(a.updatedAt));
}

/** critical > warning > info - the one deterministic ordering this layer ever applies to incidents, purely for display; never used to alter status/category itself. */
export function severityRank(severity: IncidentSeverity): number {
  if (severity === "critical") return 2;
  if (severity === "warning") return 1;
  return 0;
}

export async function getIncident(supabase: SupabaseClient, organizationId: string, incidentId: string): Promise<AutomationIncident | null> {
  const { data, error } = await supabase.from("automation_incidents").select(INCIDENT_COLUMNS).eq("organization_id", organizationId).eq("id", incidentId).maybeSingle();

  if (error || !data) return null;
  return mapIncidentRow(data as AutomationIncidentRow);
}

export type IncidentCounts = {
  activeTotal: number;
  critical: number;
  warning: number;
  info: number;
};

export async function getActiveIncidentCounts(supabase: SupabaseClient, organizationId: string): Promise<IncidentCounts> {
  const { data, error } = await supabase.from("automation_incidents").select("severity").eq("organization_id", organizationId).in("status", ["open", "acknowledged"]).limit(MAX_INCIDENT_ROWS);

  if (error || !data) return { activeTotal: 0, critical: 0, warning: 0, info: 0 };

  const rows = data as { severity: IncidentSeverity }[];
  return {
    activeTotal: rows.length,
    critical: rows.filter((r) => r.severity === "critical").length,
    warning: rows.filter((r) => r.severity === "warning").length,
    info: rows.filter((r) => r.severity === "info").length,
  };
}
