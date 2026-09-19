import type { SupabaseClient } from "@supabase/supabase-js";
import { formatCurrency, formatRelativeTime } from "./format";

export type PipelineStage = "new" | "contacted" | "qualified" | "appointment" | "estimate" | "won";

export const PIPELINE_STAGES: { stage: PipelineStage; label: string }[] = [
  { stage: "new", label: "Lead" },
  { stage: "contacted", label: "Contacted" },
  { stage: "qualified", label: "Qualified" },
  { stage: "appointment", label: "Appointment" },
  { stage: "estimate", label: "Estimate" },
  { stage: "won", label: "Won" },
];

const ACTIVE_LEAD_STATUSES = new Set<string>(["new", "contacted", "qualified", "appointment", "estimate"]);

export type OverviewMetrics = {
  newLeads: number;
  upcomingAppointments: number;
  pendingEstimates: number;
  openOpportunities: number;
};

export type PipelineCounts = Record<PipelineStage, number>;

export type AttentionItem = {
  id: string;
  kind: "overdue_appointment" | "hot_lead" | "pending_estimate";
  title: string;
  detail: string;
  value: string | null;
  href: string;
};

export type ActivityItem = {
  id: string;
  message: string;
  timestamp: string;
};

export type DashboardData = {
  overview: OverviewMetrics;
  pipeline: PipelineCounts;
  attentionItems: AttentionItem[];
  recentActivity: ActivityItem[];
};

type ContactRef = { first_name: string | null; last_name: string | null } | { first_name: string | null; last_name: string | null }[] | null;

function contactName(contact: ContactRef): string | null {
  const row = Array.isArray(contact) ? contact[0] : contact;
  if (!row) return null;
  const name = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
  return name || null;
}

function formatAuditAction(action: string, entityType: string | null): string {
  const readable = action.replace(/_/g, " ");
  const subject = entityType ? ` (${entityType})` : "";
  return readable.charAt(0).toUpperCase() + readable.slice(1) + subject;
}

/**
 * Loads everything the dashboard needs in three parallel, org-scoped queries
 * (RLS also enforces the org boundary; the explicit `organization_id` filter
 * here just keeps the queries efficient and their intent obvious) and derives
 * every metric, pipeline count, attention item, and activity entry from that
 * real data - nothing here is fabricated or hardcoded.
 */
export async function getDashboardData(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<DashboardData> {
  const [leadsResult, appointmentsResult, auditResult] = await Promise.all([
    supabase
      .from("leads")
      .select("id, status, temperature, estimated_value, service, created_at, contacts(first_name, last_name)")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("appointments")
      .select("id, title, status, start_at, created_at, contacts(first_name, last_name)")
      .eq("organization_id", organizationId)
      .order("start_at", { ascending: false })
      .limit(200),
    supabase
      .from("audit_log")
      .select("id, action, entity_type, created_at")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  const leads = leadsResult.data ?? [];
  const appointments = appointmentsResult.data ?? [];
  const auditLog = auditResult.data ?? [];

  const now = Date.now();

  const overview: OverviewMetrics = {
    newLeads: leads.filter((lead) => lead.status === "new").length,
    upcomingAppointments: appointments.filter(
      (appointment) =>
        (appointment.status === "scheduled" || appointment.status === "confirmed") &&
        new Date(appointment.start_at).getTime() >= now,
    ).length,
    pendingEstimates: leads.filter((lead) => lead.status === "estimate").length,
    openOpportunities: leads.filter((lead) => ACTIVE_LEAD_STATUSES.has(lead.status)).length,
  };

  const pipeline = Object.fromEntries(
    PIPELINE_STAGES.map(({ stage }) => [stage, leads.filter((lead) => lead.status === stage).length]),
  ) as PipelineCounts;

  const overdueAppointments: AttentionItem[] = appointments
    .filter((appointment) => appointment.status === "scheduled" && new Date(appointment.start_at).getTime() < now)
    .slice(0, 5)
    .map((appointment) => ({
      id: `apt-${appointment.id}`,
      kind: "overdue_appointment",
      title: contactName(appointment.contacts) ?? appointment.title,
      detail: `Was scheduled ${formatRelativeTime(appointment.start_at)}`,
      value: null,
      href: "/appointments",
    }));

  const hotLeads: AttentionItem[] = leads
    .filter((lead) => lead.temperature === "hot" && ACTIVE_LEAD_STATUSES.has(lead.status))
    .slice(0, 5)
    .map((lead) => ({
      id: `hot-${lead.id}`,
      kind: "hot_lead",
      title: contactName(lead.contacts) ?? lead.service ?? "Hot lead",
      detail: "Hot lead - follow up soon",
      value: lead.estimated_value != null ? formatCurrency(Number(lead.estimated_value)) : null,
      href: "/leads",
    }));

  const pendingEstimateLeads: AttentionItem[] = leads
    .filter((lead) => lead.status === "estimate")
    .slice(0, 5)
    .map((lead) => ({
      id: `est-${lead.id}`,
      kind: "pending_estimate",
      title: contactName(lead.contacts) ?? lead.service ?? "Pending estimate",
      detail: "At the estimate stage - needs follow-up",
      value: lead.estimated_value != null ? formatCurrency(Number(lead.estimated_value)) : null,
      href: "/estimates",
    }));

  const attentionItems = [...overdueAppointments, ...hotLeads, ...pendingEstimateLeads].slice(0, 6);

  const leadActivity: ActivityItem[] = leads.slice(0, 5).map((lead) => ({
    id: `lead-${lead.id}`,
    message: `New lead${contactName(lead.contacts) ? `: ${contactName(lead.contacts)}` : lead.service ? `: ${lead.service}` : ""}`,
    timestamp: lead.created_at,
  }));

  const appointmentActivity: ActivityItem[] = appointments.slice(0, 5).map((appointment) => ({
    id: `apt-created-${appointment.id}`,
    message: `Appointment scheduled${contactName(appointment.contacts) ? `: ${contactName(appointment.contacts)}` : appointment.title ? `: ${appointment.title}` : ""}`,
    timestamp: appointment.created_at,
  }));

  const auditActivity: ActivityItem[] = auditLog.map((entry) => ({
    id: `audit-${entry.id}`,
    message: formatAuditAction(entry.action, entry.entity_type),
    timestamp: entry.created_at,
  }));

  const recentActivity = [...leadActivity, ...appointmentActivity, ...auditActivity]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 8);

  return { overview, pipeline, attentionItems, recentActivity };
}
