import type { SupabaseClient } from "@supabase/supabase-js";
import { formatCurrency, formatRelativeTime } from "./format";
import { getCalendarConnection } from "@/lib/calendar/connection";
import { getConversations, getLastMessagesByConversation, attachLastMessages } from "@/lib/conversations/queries";
import type { IncidentStatus } from "@/lib/automation-health/types";

/** Q7 (pre-launch lead-leak audit): a lead below "hot" temperature but at or above this estimated value is still worth surfacing - hotLeads alone ignores value entirely. Deliberately a plain, documented constant rather than a per-organization setting - the smallest correction that fixes the real prioritization gap without building a new configuration surface. */
const HIGH_VALUE_THRESHOLD = 5000;

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
  kind: "overdue_appointment" | "hot_lead" | "high_value_lead" | "pending_estimate" | "calendar_disconnected" | "human_escalation" | "awaiting_reply";
  title: string;
  detail: string;
  value: string | null;
  href: string;
  /** HANDOFF-01: only present for kind:"human_escalation" - lets the dashboard render the existing acknowledge/resolve incident controls inline without a second lookup. */
  incidentId?: string;
  incidentStatus?: IncidentStatus;
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
  const [leadsResult, appointmentsResult, auditResult, calendarConnection, escalationIncidentsResult, conversations, lastMessages] = await Promise.all([
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
    // Growth System Completion Pass 2, Part 11: reuses the exact same safe-
    // metadata-only calendar_connections read the Agency Command Center
    // already uses (see lib/agency/health.ts's loadCalendarHealth) - the
    // contractor's own dashboard had no visibility into this at all before
    // now, only the agency admin did. Only status:"error" is ever surfaced
    // here (a real, actionable sync failure); "disconnected"/no-row-at-all
    // is a normal, common state, never itself a problem - matching the
    // agency-level AgencyCalendarStatus's identical distinction.
    getCalendarConnection(supabase, organizationId),
    // HANDOFF-01: the persisted, resolvable counterpart to notifyFounder's
    // existing transient escalation notification - see
    // lib/automation-health/service.ts's recordAutomationHealthSignal, the
    // single writer of this category. RLS (automation_incidents_select)
    // already scopes this to the caller's own organization the same way it
    // does for every other automation_incidents read; the explicit filter
    // here just keeps the query efficient and its intent obvious, matching
    // this function's own established convention for the other three reads.
    supabase
      .from("automation_incidents")
      .select("id, status, description, metadata, last_seen_at")
      .eq("organization_id", organizationId)
      .eq("category", "human_escalation_requested")
      .in("status", ["open", "acknowledged"])
      .order("last_seen_at", { ascending: false })
      .limit(5),
    // ATTN-01: reuses the exact same query pair the Conversations page
    // itself already uses to derive "awaiting reply" (see
    // app/(app)/conversations/_components/conversations-list.tsx's own
    // needsReply) - real, already-proven logic, not a new derivation.
    getConversations(supabase, organizationId),
    getLastMessagesByConversation(supabase, organizationId),
  ]);

  const leads = leadsResult.data ?? [];
  const appointments = appointmentsResult.data ?? [];
  const auditLog = auditResult.data ?? [];
  const escalationIncidents = escalationIncidentsResult.data ?? [];

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
      // BOOK-02: deep-links straight to the specific appointment (rather
      // than the generic list) so marking it complete/no-show is one click,
      // not a search - the actual gap here was friction, not visibility:
      // this item itself already existed and already catches every
      // past-due, still-`scheduled` appointment.
      href: `/appointments/${appointment.id}`,
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

  // Q7: a lead the AI never flagged "hot" can still be a large deal sitting
  // idle - estimated_value was previously never factored into attention at
  // all. Excludes anything already caught by hotLeads above, so a hot AND
  // high-value lead appears once, not twice.
  const highValueLeads: AttentionItem[] = leads
    .filter((lead) => lead.temperature !== "hot" && ACTIVE_LEAD_STATUSES.has(lead.status) && lead.estimated_value != null && Number(lead.estimated_value) >= HIGH_VALUE_THRESHOLD)
    .slice(0, 5)
    .map((lead) => ({
      id: `value-${lead.id}`,
      kind: "high_value_lead",
      title: contactName(lead.contacts) ?? lead.service ?? "High-value lead",
      detail: "High-value opportunity - follow up soon",
      value: formatCurrency(Number(lead.estimated_value)),
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

  // HANDOFF-01: the single highest-priority attention kind - a customer is
  // waiting on a human reply right now, which is more time-sensitive than
  // any of the other four kinds below. Ranked first for that reason.
  const humanEscalations: AttentionItem[] = escalationIncidents.map((incident) => {
    const metadata = (incident.metadata ?? {}) as { conversationId?: string | null };
    return {
      id: `escalation-${incident.id}`,
      kind: "human_escalation",
      title: "AI needs your attention",
      detail: incident.description ?? "A conversation needs a human reply.",
      value: null,
      href: metadata.conversationId ? `/conversations/${metadata.conversationId}` : "/conversations",
      incidentId: incident.id,
      incidentStatus: incident.status as IncidentStatus,
    };
  });

  // ATTN-01: a conversation whose most recent message is inbound and still
  // open is a customer waiting on a reply - real, already-proven data (the
  // Conversations page's own needsReply logic), just never aggregated onto
  // the dashboard before now.
  const conversationsWithLastMessage = attachLastMessages(conversations, lastMessages);
  const awaitingReply: AttentionItem[] = conversationsWithLastMessage
    .filter((conversation) => conversation.status === "open" && conversation.lastMessage?.direction === "inbound")
    .slice(0, 5)
    .map((conversation) => ({
      id: `reply-${conversation.id}`,
      kind: "awaiting_reply",
      title: contactName(conversation.contact) ?? "Customer",
      detail: `Waiting for a reply ${formatRelativeTime(conversation.lastActivityAt)}`,
      value: null,
      href: `/conversations/${conversation.id}`,
    }));

  const calendarAttention: AttentionItem[] =
    calendarConnection?.status === "error"
      ? [
          {
            id: `calendar-${calendarConnection.id}`,
            kind: "calendar_disconnected",
            title: "Google Calendar sync failed",
            detail: calendarConnection.lastError ?? "Reconnect your calendar to keep bookings in sync.",
            value: null,
            href: "/settings",
          },
        ]
      : [];

  const attentionItems = [...humanEscalations, ...awaitingReply, ...calendarAttention, ...overdueAppointments, ...hotLeads, ...highValueLeads, ...pendingEstimateLeads].slice(0, 6);

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
