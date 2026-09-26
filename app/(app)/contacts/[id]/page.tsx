import Link from "next/link";
import { redirect } from "next/navigation";
import { Briefcase, CalendarClock, FileSearch, FileX2, Flame, MessagesSquare, Wallet, CalendarCheck2, Sparkles } from "lucide-react";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getContact } from "@/lib/contacts/queries";
import { getContactRelationshipCounts } from "@/lib/contacts/duplicates";
import { getLeads, OPEN_LEAD_STATUSES } from "@/lib/leads/queries";
import { getAppointments } from "@/lib/appointments/queries";
import { getEstimates } from "@/lib/estimates/queries";
import { getConversations, CONVERSATION_CHANNELS } from "@/lib/conversations/queries";
import { getJobs } from "@/lib/jobs/queries";
import { getCustomerLifecycle } from "@/lib/customers/lifecycle";
import { getOpenOpportunities } from "@/lib/opportunities/queries";
import { getReviewRequestForJob, getReferralRequestForJob } from "@/lib/reviews-referrals/queries";
import { REVIEW_STATUS_LABELS, REFERRAL_STATUS_LABELS } from "@/lib/reviews-referrals/format";
import { ACTIVE_APPOINTMENT_STATUSES, ACTIVE_ESTIMATE_STATUSES, ACTIVE_JOB_STATUSES } from "@/lib/automation/customer-reactivation";
import { contactDisplayName, contactInitials, formatContactDate } from "@/lib/contacts/format";
import { formatCurrency } from "@/lib/dashboard/format";
import { formatAppointmentDate, formatAppointmentTimeRange, STATUS_LABELS as APPOINTMENT_STATUS_LABELS } from "@/lib/appointments/format";
import { getOrganizationTimezone } from "@/lib/settings/queries";
import { STATUS_LABELS as LEAD_STATUS_LABELS } from "@/lib/leads/format";
import { STATUS_LABELS as ESTIMATE_STATUS_LABELS } from "@/lib/estimates/format";
import { STATUS_LABELS as JOB_STATUS_LABELS } from "@/lib/jobs/format";
import { detailLabelClass, detailValueClass, subsectionTitleClass } from "@/lib/ui/typography";
import { Badge, type BadgeTone } from "@/lib/ui/badge";
import { EmptyState } from "@/lib/ui/empty-state";
import { SectionCard, Panel } from "@/lib/ui/section-card";
import { DetailHeader } from "@/lib/ui/detail-header";
import { LEAD_STATUS_TONE } from "../../leads/_components/lead-status";
import { APPOINTMENT_STATUS_TONE, APPOINTMENT_STATUS_ICON } from "../../appointments/_components/status";
import { ESTIMATE_STATUS_TONE, ESTIMATE_STATUS_ICON } from "../../estimates/_components/status";
import { JOB_STATUS_TONE, JOB_STATUS_ICON } from "../../jobs/_components/status";
import { ContactActions } from "./_components/contact-actions";
import { summarizeOpenLeadValue, formatOpenLeadValueDisplay } from "@/lib/contacts/open-lead-value";

const OPPORTUNITY_TYPE_LABELS: Record<string, string> = {
  qualified_lead_unbooked: "Qualified, not booked",
  stale_estimate: "Estimate expired",
  completed_appointment_no_estimate: "Visited, no estimate",
  dormant_customer: "Dormant",
  no_show: "No-show",
  completed_job_no_referral_request: "No referral request yet",
  uncontacted_lead: "Uncontacted lead",
  accepted_estimate_no_job: "Accepted estimate - job not scheduled",
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

  const [contact, relationshipCounts, allLeads, allAppointments, allEstimates, allConversations, allJobs, lifecycle, allOpenOpportunities, timeZone] = await Promise.all([
    getContact(supabase, membership.organizationId, id),
    getContactRelationshipCounts(supabase, membership.organizationId, id),
    getLeads(supabase, membership.organizationId),
    getAppointments(supabase, membership.organizationId),
    getEstimates(supabase, membership.organizationId),
    getConversations(supabase, membership.organizationId),
    getJobs(supabase, membership.organizationId),
    // Pass 4 P1-A: reused as-is, all-time/current-state (see the function's
    // own header for why it's never scoped to a reporting window).
    getCustomerLifecycle(supabase, membership.organizationId, id),
    // Reused from the dashboard's own read - filtered to this contact below,
    // matching this page's own established "fetch org-wide, filter locally"
    // pattern for leads/appointments/estimates/jobs/conversations above.
    getOpenOpportunities(supabase, membership.organizationId),
    // Trackpr 2.0, Launch Certification QA fix: appointment.start_at/end_at
    // are stored/read as UTC ISO strings - without an explicit IANA
    // timeZone, formatAppointmentDate/formatAppointmentTimeRange below fall
    // back to the server runtime's own default (UTC on Vercel), rendering a
    // real appointment several hours off from what it actually shows on
    // /appointments and /schedule (both of which already fetch and pass
    // this same organization timezone). Matches the exact pattern
    // app/(app)/appointments/page.tsx already uses.
    getOrganizationTimezone(supabase, membership.organizationId),
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
  const openOpportunities = allOpenOpportunities.filter((opportunity) => opportunity.contactId === contact.id);

  // Pass 4 P1-F fix: NULL estimated_value must stay unknown, never coerced
  // to $0 - a lead with no known value is not the same fact as a lead
  // worth exactly zero dollars. See ./_lib/open-lead-value.ts for why this
  // is a small extracted, unit-tested function rather than inline logic.
  const openLeadCount = leads.filter((lead) => lead.status !== "won" && lead.status !== "lost").length;
  const openLeadsValueSummary = summarizeOpenLeadValue(leads);
  const openLeadsValueDisplay = formatOpenLeadValueDisplay(openLeadsValueSummary, openLeadCount, formatCurrency);

  // Pass 4 P1-A: reuses the exact same active-engagement definition
  // lib/automation/customer-reactivation.ts and lib/opportunities/detect.ts
  // already use - never a second, possibly-drifting definition.
  const hasActiveEngagement =
    leads.some((lead) => OPEN_LEAD_STATUSES.has(lead.status)) ||
    appointments.some((appointment) => ACTIVE_APPOINTMENT_STATUSES.includes(appointment.status)) ||
    estimates.some((estimate) => ACTIVE_ESTIMATE_STATUSES.includes(estimate.status)) ||
    jobs.some((job) => ACTIVE_JOB_STATUSES.includes(job.status));
  const hasOpenDormantOpportunity = openOpportunities.some((opportunity) => opportunity.type === "dormant_customer");

  let lifecycleStatus: string;
  let lifecycleStatusTone: BadgeTone;
  if (hasOpenDormantOpportunity) {
    lifecycleStatus = "Dormant";
    lifecycleStatusTone = "warning";
  } else if (hasActiveEngagement) {
    lifecycleStatus = "Active";
    lifecycleStatusTone = "info";
  } else if (lifecycle.isRepeatCustomer) {
    lifecycleStatus = "Repeat customer";
    lifecycleStatusTone = "success";
  } else if (lifecycle.totalCompletedJobs === 1) {
    lifecycleStatus = "One completed job";
    lifecycleStatusTone = "neutral";
  } else {
    lifecycleStatus = "No completed jobs yet";
    lifecycleStatusTone = "neutral";
  }

  // "Review/referral status only where existing data is unambiguous" - the
  // single choice that stays unambiguous for a customer with multiple jobs
  // is the most recently completed one, matching how the dormant_customer
  // detector itself anchors on the same job.
  const mostRecentCompletedJob = jobs
    .filter((job) => job.status === "completed" && job.completed_at)
    .sort((a, b) => ((b.completed_at as string) < (a.completed_at as string) ? -1 : 1))[0] ?? null;
  const [reviewRequest, referralRequest] = mostRecentCompletedJob
    ? await Promise.all([
        getReviewRequestForJob(supabase, membership.organizationId, mostRecentCompletedJob.id),
        getReferralRequestForJob(supabase, membership.organizationId, mostRecentCompletedJob.id),
      ])
    : [null, null];

  return (
    <div className="flex flex-1 flex-col">
      {/*
        CONTACT hierarchy: identity -> communication -> activity -> related
        records. Contacts have no status enum (they're people, not a
        pipeline stage), so the header's meta row carries this customer's
        relationship snapshot instead - the same four real counts the old
        StatGrid showed, now the thing that answers "how much history do I
        have with this person" right in the header.
      */}
      <DetailHeader
        eyebrow="Contact"
        backHref="/contacts"
        backLabel="Back to Contacts"
        avatar={
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-slate-100 text-base font-medium text-slate-600 ring-1 ring-inset ring-slate-200">
            {contactInitials(contact)}
          </span>
        }
        title={name}
        subtitle={contact.company_name ?? undefined}
        action={<ContactActions contact={contact} />}
        meta={
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
            {[
              { label: "Leads", value: String(relationshipCounts.leads), icon: Flame },
              { label: "Open opportunity value", value: openLeadsValueDisplay, icon: Wallet },
              { label: "Appointments", value: String(relationshipCounts.appointments), icon: CalendarCheck2 },
              { label: "Jobs", value: String(relationshipCounts.jobs), icon: Briefcase },
            ].map((stat) => (
              <div key={stat.label}>
                <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  <stat.icon className="h-3 w-3 shrink-0" aria-hidden />
                  {stat.label}
                </p>
                <p className="mt-1 text-xl font-bold tabular-nums text-slate-900">{stat.value}</p>
              </div>
            ))}
          </div>
        }
      />

      <div className="flex flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
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
                          {formatAppointmentDate(appointment.start_at, timeZone)} ·{" "}
                          {formatAppointmentTimeRange(appointment.start_at, appointment.end_at, timeZone)}
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
                      <Badge tone={JOB_STATUS_TONE[job.status]} icon={JOB_STATUS_ICON[job.status]}>
                        {JOB_STATUS_LABELS[job.status]}
                      </Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>

        {/* SIDEBAR: contact details, notes, timestamps */}
        <div className="flex flex-col gap-6">
          {/* Pass 4 P1-A: compact customer intelligence - reuses
              lib/customers/lifecycle.ts and the opportunities table exactly
              as-is, never a second calculation. Kept to a single dl of real
              facts, matching the existing "Details" panel's own visual
              weight - not a new reporting page. */}
          <Panel>
            <div className="flex items-center justify-between gap-3">
              <h2 className={subsectionTitleClass}>Customer intelligence</h2>
              <Badge tone={lifecycleStatusTone} icon={Sparkles}>
                {lifecycleStatus}
              </Badge>
            </div>
            <dl className="mt-3 space-y-3">
              <div>
                <dt className={detailLabelClass}>Completed jobs</dt>
                <dd className={detailValueClass}>{lifecycle.totalCompletedJobs}</dd>
              </div>
              {lifecycle.totalCompletedJobs > 0 ? (
                <>
                  <div>
                    <dt className={detailLabelClass}>Known completed-job value</dt>
                    <dd className={detailValueClass}>
                      {lifecycle.knownCompletedJobValueCount > 0 ? formatCurrency(lifecycle.knownCompletedJobValue) : "Unknown"}
                      {lifecycle.averageKnownCompletedJobValue != null ? (
                        <span className="ml-1.5 text-xs font-normal text-slate-400">{formatCurrency(lifecycle.averageKnownCompletedJobValue)} average</span>
                      ) : null}
                    </dd>
                  </div>
                  <div>
                    <dt className={detailLabelClass}>Last completed job</dt>
                    <dd className={detailValueClass}>
                      {formatContactDate(lifecycle.lastCompletedJobAt as string)}
                      {lifecycle.daysSinceLastCompletedJob != null ? (
                        <span className="ml-1.5 text-xs font-normal text-slate-400">{lifecycle.daysSinceLastCompletedJob} days ago</span>
                      ) : null}
                    </dd>
                  </div>
                  <div>
                    <dt className={detailLabelClass}>First completed job</dt>
                    <dd className={detailValueClass}>{formatContactDate(lifecycle.firstCompletedJobAt as string)}</dd>
                  </div>
                </>
              ) : (
                <p className="text-sm text-slate-500">No completed jobs yet.</p>
              )}
              {openOpportunities.length > 0 ? (
                <div>
                  <dt className={detailLabelClass}>Open opportunities</dt>
                  <dd className={`${detailValueClass} space-y-1`}>
                    {openOpportunities.map((opportunity) => (
                      <span key={opportunity.id} className="block text-sm font-normal text-slate-700">
                        {OPPORTUNITY_TYPE_LABELS[opportunity.type] ?? opportunity.type}
                        {opportunity.estimatedValue != null ? ` · ${formatCurrency(opportunity.estimatedValue)}` : ""}
                      </span>
                    ))}
                  </dd>
                </div>
              ) : null}
              {reviewRequest ? (
                <div>
                  <dt className={detailLabelClass}>Review status</dt>
                  <dd className={detailValueClass}>{REVIEW_STATUS_LABELS[reviewRequest.status]}</dd>
                </div>
              ) : null}
              {referralRequest ? (
                <div>
                  <dt className={detailLabelClass}>Referral status</dt>
                  <dd className={detailValueClass}>{REFERRAL_STATUS_LABELS[referralRequest.status]}</dd>
                </div>
              ) : null}
            </dl>
          </Panel>

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
    </div>
  );
}
