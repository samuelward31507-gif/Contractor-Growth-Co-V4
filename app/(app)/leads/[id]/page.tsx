import Link from "next/link";
import { redirect } from "next/navigation";
import { CalendarClock, FileSearch, MessagesSquare, Sparkles, Flame } from "lucide-react";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getContacts } from "@/lib/contacts/queries";
import { getLead } from "@/lib/leads/queries";
import { getAppointments } from "@/lib/appointments/queries";
import { getEstimates } from "@/lib/estimates/queries";
import { getConversations } from "@/lib/conversations/queries";
import {
  STATUS_LABELS as APPOINTMENT_STATUS_LABELS,
  formatAppointmentDate,
  formatAppointmentTimeRange,
} from "@/lib/appointments/format";
import { STATUS_LABELS as ESTIMATE_STATUS_LABELS } from "@/lib/estimates/format";
import { CONVERSATION_CHANNELS } from "@/lib/conversations/queries";
import { contactDisplayName, contactInitials, formatContactDate } from "@/lib/contacts/format";
import { formatCurrency } from "@/lib/dashboard/format";
import { STATUS_LABELS, TEMPERATURE_LABELS } from "@/lib/leads/format";
import { detailLabelClass, detailValueClass, subsectionTitleClass } from "@/lib/ui/typography";
import { Badge } from "@/lib/ui/badge";
import { EmptyState } from "@/lib/ui/empty-state";
import { SectionCard, Panel } from "@/lib/ui/section-card";
import { DetailHeader } from "@/lib/ui/detail-header";
import { LEAD_STATUS_TONE, LEAD_TEMPERATURE_TONE } from "../_components/lead-status";
import { APPOINTMENT_STATUS_TONE, APPOINTMENT_STATUS_ICON } from "../../appointments/_components/status";
import { ESTIMATE_STATUS_TONE, ESTIMATE_STATUS_ICON } from "../../estimates/_components/status";
import { LeadActions } from "./_components/lead-actions";

const CHANNEL_LABEL = Object.fromEntries(CONVERSATION_CHANNELS.map((item) => [item.value, item.label]));

export default async function LeadDetailPage({ params }: PageProps<"/leads/[id]">) {
  const { id } = await params;

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const membership = await getUserOrganization(supabase, user.id);
  if (!membership) {
    redirect("/onboarding");
  }

  const [lead, contacts, allAppointments, allEstimates, allConversations] = await Promise.all([
    getLead(supabase, membership.organizationId, id),
    getContacts(supabase, membership.organizationId),
    getAppointments(supabase, membership.organizationId),
    getEstimates(supabase, membership.organizationId),
    getConversations(supabase, membership.organizationId),
  ]);

  if (!lead) {
    return (
      <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
        <EmptyState
          icon={FileSearch}
          title="Lead not found"
          description="This lead may have been deleted, or the link is incorrect."
          action={
            <Link href="/leads" className="text-sm font-medium text-slate-900 hover:underline">
              Back to Leads
            </Link>
          }
        />
      </div>
    );
  }

  const contactName = lead.contact ? contactDisplayName(lead.contact) : "No contact";
  const hasAiInsight = lead.ai_score != null || Boolean(lead.ai_summary);

  const appointments = allAppointments
    .filter((appointment) => appointment.lead_id === lead.id)
    .sort((a, b) => new Date(b.start_at).getTime() - new Date(a.start_at).getTime());
  const estimates = allEstimates
    .filter((estimate) => estimate.lead_id === lead.id)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const conversations = allConversations
    .filter((conversation) => conversation.lead_id === lead.id)
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

  return (
    <div className="flex flex-1 flex-col">
      {/*
        LEAD hierarchy: identity -> qualification -> activity -> related
        records. Value and temperature are the two facts that decide "how
        urgently do I chase this" - both surface directly in the header's
        meta row, not buried below the fold.
      */}
      <DetailHeader
        eyebrow="Lead"
        backHref="/leads"
        backLabel="Back to Leads"
        avatar={
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-slate-100 text-base font-medium text-slate-600 ring-1 ring-inset ring-slate-200">
            {lead.contact ? contactInitials(lead.contact) : "?"}
          </span>
        }
        title={contactName}
        subtitle={lead.service || "General inquiry"}
        badges={
          <>
            <Badge tone={LEAD_STATUS_TONE[lead.status]}>{STATUS_LABELS[lead.status]}</Badge>
            <Badge tone={LEAD_TEMPERATURE_TONE[lead.temperature]} icon={lead.temperature === "hot" ? Flame : undefined}>
              {TEMPERATURE_LABELS[lead.temperature]}
            </Badge>
          </>
        }
        action={<LeadActions lead={lead} contacts={contacts} />}
        meta={
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Estimated value</p>
            <p className="mt-1 text-3xl font-bold tracking-tight tabular-nums text-slate-900">
              {lead.estimated_value != null ? formatCurrency(lead.estimated_value) : "—"}
            </p>
          </div>
        }
      />

      <div className="flex flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:gap-8">
          {/* MAIN COLUMN: qualification, then activity/related records */}
          <div className="flex flex-col gap-6 lg:col-span-2">
            <SectionCard title="Qualification" description="AI scoring and summary for this opportunity." icon={Sparkles}>
              {hasAiInsight ? (
                <div className="space-y-3">
                  {lead.ai_score != null ? (
                    <div>
                      <dt className={detailLabelClass}>Score</dt>
                      <dd className={detailValueClass}>{lead.ai_score} / 100</dd>
                    </div>
                  ) : null}
                  {lead.ai_summary ? (
                    <div>
                      <dt className={detailLabelClass}>Summary</dt>
                      <dd className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{lead.ai_summary}</dd>
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="text-sm text-slate-500">Not analyzed yet.</p>
              )}
            </SectionCard>

            <SectionCard title="Conversations" description="Messages and calls tied to this lead." icon={MessagesSquare}>
              {conversations.length === 0 ? (
                <p className="text-sm text-slate-500">No conversations yet for this lead.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {conversations.map((conversation) => (
                    <li key={conversation.id}>
                      <Link
                        href={`/conversations/${conversation.id}`}
                        className="flex items-center justify-between gap-3 py-2.5 text-sm transition-colors hover:text-slate-900"
                      >
                        <span className="flex items-center gap-2 text-slate-700">
                          <span className="font-medium">{CHANNEL_LABEL[conversation.channel] ?? conversation.channel}</span>
                          <span className="text-xs text-slate-400">Updated {formatContactDate(conversation.updated_at)}</span>
                        </span>
                        <Badge tone={conversation.status === "open" ? "info" : "neutral"}>
                          {conversation.status === "open" ? "Open" : "Closed"}
                        </Badge>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>

            <SectionCard title="Appointments" description="Scheduled and past visits for this lead." icon={CalendarClock}>
              {appointments.length === 0 ? (
                <p className="text-sm text-slate-500">No appointments scheduled for this lead.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {appointments.map((appointment) => (
                    <li key={appointment.id}>
                      <Link
                        href={`/appointments/${appointment.id}`}
                        className="flex items-center justify-between gap-3 py-2.5 text-sm transition-colors hover:text-slate-900"
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-slate-900">{appointment.title}</span>
                          <span className="block text-xs text-slate-500">
                            {formatAppointmentDate(appointment.start_at)} ·{" "}
                            {formatAppointmentTimeRange(appointment.start_at, appointment.end_at)}
                          </span>
                        </span>
                        <Badge tone={APPOINTMENT_STATUS_TONE[appointment.status]} icon={APPOINTMENT_STATUS_ICON[appointment.status]}>
                          {APPOINTMENT_STATUS_LABELS[appointment.status]}
                        </Badge>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>

            <SectionCard title="Estimates" description="Estimates prepared for this opportunity." icon={FileSearch}>
              {estimates.length === 0 ? (
                <p className="text-sm text-slate-500">No estimates prepared for this lead yet.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {estimates.map((estimate) => (
                    <li key={estimate.id}>
                      <Link
                        href={`/estimates/${estimate.id}`}
                        className="flex items-center justify-between gap-3 py-2.5 text-sm transition-colors hover:text-slate-900"
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-slate-900">{estimate.title}</span>
                          <span className="block text-xs text-slate-500">{formatContactDate(estimate.created_at)}</span>
                        </span>
                        <span className="flex items-center gap-2">
                          <span className="text-sm font-medium tabular-nums text-slate-700">
                            {estimate.amount != null ? formatCurrency(estimate.amount) : "—"}
                          </span>
                          <Badge tone={ESTIMATE_STATUS_TONE[estimate.status]} icon={ESTIMATE_STATUS_ICON[estimate.status]}>
                            {ESTIMATE_STATUS_LABELS[estimate.status]}
                          </Badge>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </div>

          {/* SIDEBAR: contact info, source, status, timestamps */}
          <div className="flex flex-col gap-6">
            {lead.contact ? (
              <SectionCard
                title="Contact"
                action={
                  <Link href={`/contacts/${lead.contact.id}`} className="text-xs font-medium text-slate-600 hover:text-slate-900">
                    View contact
                  </Link>
                }
              >
                <dl className="space-y-3">
                  <div>
                    <dt className={detailLabelClass}>Name</dt>
                    <dd className={detailValueClass}>{contactDisplayName(lead.contact)}</dd>
                  </div>
                  {lead.contact.phone ? (
                    <div>
                      <dt className={detailLabelClass}>Phone</dt>
                      <dd className={detailValueClass}>{lead.contact.phone}</dd>
                    </div>
                  ) : null}
                  {lead.contact.email ? (
                    <div>
                      <dt className={detailLabelClass}>Email</dt>
                      <dd className={detailValueClass}>{lead.contact.email}</dd>
                    </div>
                  ) : null}
                </dl>
              </SectionCard>
            ) : null}

            <Panel>
              <h2 className={subsectionTitleClass}>Details</h2>
              <dl className="mt-3 space-y-3">
                <div>
                  <dt className={detailLabelClass}>Source</dt>
                  <dd className={detailValueClass}>{lead.source || "—"}</dd>
                </div>
                <div>
                  <dt className={detailLabelClass}>Added</dt>
                  <dd className={detailValueClass}>{formatContactDate(lead.created_at)}</dd>
                </div>
                {lead.updated_at !== lead.created_at ? (
                  <div>
                    <dt className={detailLabelClass}>Last updated</dt>
                    <dd className={detailValueClass}>{formatContactDate(lead.updated_at)}</dd>
                  </div>
                ) : null}
              </dl>
            </Panel>
          </div>
        </div>
      </div>
    </div>
  );
}
