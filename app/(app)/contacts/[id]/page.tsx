import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, Briefcase, CalendarClock, FileSearch, FileX2, Flame, MessagesSquare, Wallet } from "lucide-react";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getContact } from "@/lib/contacts/queries";
import { getContactRelationshipCounts } from "@/lib/contacts/duplicates";
import { getLeads } from "@/lib/leads/queries";
import { getAppointments } from "@/lib/appointments/queries";
import { getEstimates } from "@/lib/estimates/queries";
import { getConversations, CONVERSATION_CHANNELS } from "@/lib/conversations/queries";
import { getJobs } from "@/lib/jobs/queries";
import { contactDisplayName, contactInitials, formatContactDate } from "@/lib/contacts/format";
import { formatCurrency } from "@/lib/dashboard/format";
import { formatAppointmentDate, formatAppointmentTimeRange, STATUS_LABELS as APPOINTMENT_STATUS_LABELS } from "@/lib/appointments/format";
import { STATUS_LABELS as LEAD_STATUS_LABELS } from "@/lib/leads/format";
import { STATUS_LABELS as ESTIMATE_STATUS_LABELS } from "@/lib/estimates/format";
import { STATUS_LABELS as JOB_STATUS_LABELS } from "@/lib/jobs/format";
import { detailLabelClass, detailValueClass, subsectionTitleClass } from "@/lib/ui/typography";
import { Badge, type BadgeTone } from "@/lib/ui/badge";
import { EmptyState } from "@/lib/ui/empty-state";
import { SectionCard, Panel } from "@/lib/ui/section-card";
import { StatGrid, StatCard } from "@/lib/ui/stat-card";
import type { LeadStatus } from "@/lib/leads/queries";
import type { AppointmentStatus } from "@/lib/appointments/queries";
import type { EstimateStatus } from "@/lib/estimates/queries";
import type { JobStatus } from "@/lib/jobs/queries";
import { ContactActions } from "./_components/contact-actions";

const LEAD_STATUS_TONE: Record<LeadStatus, BadgeTone> = {
  new: "neutral",
  contacted: "neutral",
  qualified: "info",
  appointment: "info",
  estimate: "warning",
  won: "success",
  lost: "danger",
};

const APPOINTMENT_STATUS_TONE: Record<AppointmentStatus, BadgeTone> = {
  scheduled: "neutral",
  confirmed: "info",
  completed: "success",
  cancelled: "danger",
  no_show: "warning",
};

const ESTIMATE_STATUS_TONE: Record<EstimateStatus, BadgeTone> = {
  draft: "neutral",
  sent: "info",
  accepted: "success",
  declined: "danger",
  cancelled: "neutral",
  expired: "warning",
};

const JOB_STATUS_TONE: Record<JobStatus, BadgeTone> = {
  scheduled: "neutral",
  in_progress: "info",
  completed: "success",
  cancelled: "danger",
};

const CHANNEL_LABEL = Object.fromEntries(CONVERSATION_CHANNELS.map((item) => [item.value, item.label]));

export default async function ContactDetailPage({ params }: PageProps<"/contacts/[id]">) {
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

  const [contact, relationshipCounts, allLeads, allAppointments, allEstimates, allConversations, allJobs] = await Promise.all([
    getContact(supabase, membership.organizationId, id),
    getContactRelationshipCounts(supabase, membership.organizationId, id),
    getLeads(supabase, membership.organizationId),
    getAppointments(supabase, membership.organizationId),
    getEstimates(supabase, membership.organizationId),
    getConversations(supabase, membership.organizationId),
    getJobs(supabase, membership.organizationId),
  ]);

  if (!contact) {
    return (
      <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
        <EmptyState
          icon={FileX2}
          title="Contact not found"
          description="This contact may have been deleted, or the link is incorrect."
          action={
            <Link href="/contacts" className="text-sm font-medium text-slate-900 hover:underline">
              Back to Contacts
            </Link>
          }
        />
      </div>
    );
  }

  const name = contactDisplayName(contact);
  const infoFields: { label: string; value: string | null }[] = [
    { label: "Phone", value: contact.phone },
    { label: "Email", value: contact.email },
    { label: "Company", value: contact.company_name },
  ].filter((field) => field.value);

  const leads = allLeads
    .filter((lead) => lead.contact_id === contact.id)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const appointments = allAppointments
    .filter((appointment) => appointment.contact_id === contact.id)
    .sort((a, b) => new Date(b.start_at).getTime() - new Date(a.start_at).getTime());
  const estimates = allEstimates
    .filter((estimate) => estimate.contact_id === contact.id)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const conversations = allConversations
    .filter((conversation) => conversation.contact_id === contact.id)
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  const jobs = allJobs
    .filter((job) => job.contact_id === contact.id)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const openLeadsValue = leads
    .filter((lead) => lead.status !== "won" && lead.status !== "lost")
    .reduce((sum, lead) => sum + (lead.estimated_value ?? 0), 0);

  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <Link
        href="/contacts"
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-slate-500 transition-colors hover:text-slate-900"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Back to Contacts
      </Link>

      {/* IDENTITY: who is this? */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-slate-100 text-base font-medium text-slate-600">
            {contactInitials(contact)}
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">{name}</h1>
            {contact.company_name ? <p className="text-sm text-slate-500">{contact.company_name}</p> : null}
          </div>
        </div>
        <ContactActions contact={contact} />
      </div>

      {/* SNAPSHOT: a quick read of this customer's relationship value. Final
          visual polish pass: StatGrid/StatCard (lib/ui/stat-card.tsx)
          instead of an inline label/value strip, so these numbers use the
          available desktop width. Open opportunity value gets the one
          success-tone icon chip here - it's the genuinely positive/money
          signal among the four. */}
      <div className="border-t border-slate-200 pt-8">
        <StatGrid columns={4}>
          <StatCard label="Leads" value={relationshipCounts.leads} />
          <StatCard label="Open opportunity value" value={formatCurrency(openLeadsValue)} tone="success" icon={Wallet} />
          <StatCard label="Appointments" value={relationshipCounts.appointments} />
          <StatCard label="Jobs" value={relationshipCounts.jobs} />
        </StatGrid>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:gap-8">
        {/* MAIN COLUMN: this customer's history across the CRM */}
        <div className="flex flex-col gap-6 lg:col-span-2">
          <SectionCard title="Leads" description="Opportunities tied to this contact." icon={Flame}>
            {leads.length === 0 ? (
              <p className="text-sm text-slate-500">No leads for this contact yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {leads.map((lead) => (
                  <li key={lead.id}>
                    <Link
                      href={`/leads/${lead.id}`}
                      className="flex items-center justify-between gap-3 py-2.5 text-sm transition-colors hover:text-slate-900"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-slate-900">{lead.service || "General inquiry"}</span>
                        <span className="block text-xs text-slate-500">{formatContactDate(lead.created_at)}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="text-sm font-medium tabular-nums text-slate-700">
                          {lead.estimated_value != null ? formatCurrency(lead.estimated_value) : "—"}
                        </span>
                        <Badge tone={LEAD_STATUS_TONE[lead.status]}>{LEAD_STATUS_LABELS[lead.status]}</Badge>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard title="Conversations" description="Messages and calls with this contact." icon={MessagesSquare}>
            {conversations.length === 0 ? (
              <p className="text-sm text-slate-500">No conversations with this contact yet.</p>
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

          <SectionCard title="Appointments" description="Scheduled and past visits." icon={CalendarClock}>
            {appointments.length === 0 ? (
              <p className="text-sm text-slate-500">No appointments for this contact yet.</p>
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
                      <Badge tone={APPOINTMENT_STATUS_TONE[appointment.status]}>
                        {APPOINTMENT_STATUS_LABELS[appointment.status]}
                      </Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard title="Estimates" description="Estimates prepared for this contact." icon={FileSearch}>
            {estimates.length === 0 ? (
              <p className="text-sm text-slate-500">No estimates for this contact yet.</p>
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
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="text-sm font-medium tabular-nums text-slate-700">
                          {estimate.amount != null ? formatCurrency(estimate.amount) : "—"}
                        </span>
                        <Badge tone={ESTIMATE_STATUS_TONE[estimate.status]}>{ESTIMATE_STATUS_LABELS[estimate.status]}</Badge>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard title="Jobs" description="Completed and in-progress work." icon={Briefcase}>
            {jobs.length === 0 ? (
              <p className="text-sm text-slate-500">No jobs for this contact yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {jobs.map((job) => (
                  <li key={job.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-slate-900">{job.title}</span>
                      <span className="block text-xs text-slate-500">{formatContactDate(job.created_at)}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="text-sm font-medium tabular-nums text-slate-700">
                        {job.amount != null ? formatCurrency(job.amount) : "—"}
                      </span>
                      <Badge tone={JOB_STATUS_TONE[job.status]}>{JOB_STATUS_LABELS[job.status]}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>

        {/* SIDEBAR: contact details, notes, timestamps */}
        <div className="flex flex-col gap-6">
          <SectionCard title="Contact information">
            {infoFields.length > 0 ? (
              <dl className="space-y-3">
                {infoFields.map((field) => (
                  <div key={field.label}>
                    <dt className={detailLabelClass}>{field.label}</dt>
                    <dd className={detailValueClass}>{field.value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-sm text-slate-500">No contact details provided yet.</p>
            )}
          </SectionCard>

          {contact.notes ? (
            <Panel>
              <h2 className={subsectionTitleClass}>Notes</h2>
              <p className="mt-3 whitespace-pre-wrap text-sm text-slate-700">{contact.notes}</p>
            </Panel>
          ) : null}

          <Panel>
            <h2 className={subsectionTitleClass}>Details</h2>
            <dl className="mt-3 space-y-3">
              <div>
                <dt className={detailLabelClass}>Added</dt>
                <dd className={detailValueClass}>{formatContactDate(contact.created_at)}</dd>
              </div>
              {contact.updated_at !== contact.created_at ? (
                <div>
                  <dt className={detailLabelClass}>Last updated</dt>
                  <dd className={detailValueClass}>{formatContactDate(contact.updated_at)}</dd>
                </div>
              ) : null}
            </dl>
          </Panel>
        </div>
      </div>
    </div>
  );
}
