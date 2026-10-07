import Link from "next/link";
import { redirect } from "next/navigation";
import { getRequestMembership, getRequestSupabase } from "@/lib/auth/request-context";
import { Phone, MessageCircle, Briefcase, CalendarClock, FileSearch, Flame, MessagesSquare, Wallet, CalendarCheck2, Sparkles, ArrowRight, AlertCircle, FileX2, Receipt } from "lucide-react";
import { getContact, getContacts } from "@/lib/contacts/queries";
import { getContactRelationshipCounts } from "@/lib/contacts/duplicates";
import { getContactLeads, OPEN_LEAD_STATUSES } from "@/lib/leads/queries";
import { summarizeOpenLeadValue, formatOpenLeadValueDisplay } from "@/lib/contacts/open-lead-value";
import { getAppointmentsForContact } from "@/lib/appointments/queries";
import { getContactEstimates } from "@/lib/estimates/queries";
import { getContactConversations, getMessages, CONVERSATION_CHANNELS } from "@/lib/conversations/queries";
import { getContactJobs } from "@/lib/jobs/queries";
import { getContactInvoices } from "@/lib/invoices/queries";
import { calendarDateInTimeZone, formatInvoiceNumber, formatMoney, isOverdue } from "@/lib/invoices/domain";
import { getCustomerLifecycle } from "@/lib/customers/lifecycle";
import { getOpenOpportunities } from "@/lib/opportunities/queries";
import { getReviewRequestForJob, getReferralRequestForJob, getReviewRequestsForJobs, getReferralRequestsForJobs } from "@/lib/reviews-referrals/queries";
import { REVIEW_STATUS_LABELS, REFERRAL_STATUS_LABELS } from "@/lib/reviews-referrals/format";
import { getLeadStageHistory } from "@/lib/automation/lead-stage-history";
import { ACTIVE_APPOINTMENT_STATUSES, ACTIVE_ESTIMATE_STATUSES, ACTIVE_JOB_STATUSES } from "@/lib/automation/customer-reactivation";
import { contactDisplayName, contactInitials, formatContactDate } from "@/lib/contacts/format";
import { formatCurrency, formatRelativeTime } from "@/lib/dashboard/format";
import { formatAppointmentDate, formatAppointmentTimeRange, STATUS_LABELS as APPOINTMENT_STATUS_LABELS } from "@/lib/appointments/format";
import { getOrganizationTimezone } from "@/lib/settings/queries";
import { STATUS_LABELS as LEAD_STATUS_LABELS } from "@/lib/leads/format";
import { STATUS_LABELS as ESTIMATE_STATUS_LABELS } from "@/lib/estimates/format";
import { STATUS_LABELS as JOB_STATUS_LABELS } from "@/lib/jobs/format";
import { detailLabelClass, detailValueClass, subsectionTitleClass, cardTitleClass, pageDescriptionClass } from "@/lib/ui/typography";
import { Badge, type BadgeTone } from "@/lib/ui/badge";
import { EmptyState } from "@/lib/ui/empty-state";
import { Panel } from "@/lib/ui/section-card";
import { DetailHeader } from "@/lib/ui/detail-header";
import { primaryButtonAutoClass, secondaryButtonAutoClass } from "@/lib/ui/form";
import { LEAD_STATUS_TONE } from "../../leads/_components/lead-status";
import { ContactActions } from "../../contacts/[id]/_components/contact-actions";
import { LeadActions } from "../../leads/[id]/_components/lead-actions";
import { FollowupRunNow } from "../../leads/[id]/_components/followup-run-now";
import { LeadTouchRunNow } from "../../leads/[id]/_components/lead-touch-run-now";
import { isCustomerReplySimulationEnvironment } from "@/lib/messaging/simulate-customer-reply";
import { FOLLOWUP_STATE_LABELS } from "@/lib/followups/format";
import { touchCount, type FollowupStage } from "@/lib/followups/config";
import type { FollowupState } from "@/lib/followups/state";
import { APPOINTMENT_STATUS_TONE, APPOINTMENT_STATUS_ICON } from "../../appointments/_components/status";
import { ESTIMATE_STATUS_TONE, ESTIMATE_STATUS_ICON } from "../../estimates/_components/status";
import { JOB_STATUS_TONE, JOB_STATUS_ICON } from "../../jobs/_components/status";
import { INVOICE_STATUS_TONE, INVOICE_STATUS_ICON, INVOICE_STATUS_LABELS } from "../../invoices/_components/status";
import { buildPersonTimeline, formatTimelineTimestamp } from "@/lib/people/timeline";
import { findPersonNextStep } from "@/lib/people/next-step";
import { loadLifecyclePolicy } from "@/lib/people/lifecycle-policy";
import { getWaitingConversationIds } from "@/lib/conversations/waiting";
import { CreateEstimateButton } from "./_components/create-estimate-button";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";
// Phase 2-13 (D3): the shared registry labels - every type, never a raw code.
import { OPPORTUNITY_TYPE_LABEL } from "@/lib/decisions/registry";


const CHANNEL_LABEL = Object.fromEntries(CONVERSATION_CHANNELS.map((item) => [item.value, item.label]));

/**
 * Phase 3 (People pass): the unified person page - one human, one page,
 * finishing the merge the repo's own comments (contacts/page.tsx,
 * customers/page.tsx) already flagged as deferred twice. Keyed by contact
 * id (a Lead is a stage on a Customer, never a merged entity - the same
 * mental model app/(app)/contacts/[id]/page.tsx's own header comment
 * already established), so a repeat customer's whole history - every
 * lead, every job, across however many times they've called - lives on
 * one page instead of splitting across /leads/[id] visits that reset
 * per-lead.
 *
 * /leads/[id] and /contacts/[id] are BOTH left completely unmodified and
 * fully reachable - this is a new, additional route, not a replacement.
 * Nothing here is deleted until the plan's own correctness bar is met:
 * every fact those two pages show is reachable from this one too.
 */
export default async function PersonDetailPage({ params }: PageProps<"/people/[id]">) {
  const { id } = await params;

  const supabase = await getRequestSupabase();
  const { user, membership } = await getRequestMembership();

  if (!user) {
    redirect("/login");
  }

  if (!membership) {
    redirect("/onboarding");
  }

  const [contact, contacts, relationshipCounts, allLeads, allAppointments, allEstimates, allConversations, allJobs, lifecycle, allOpenOpportunities, timeZone, invoices, waiting] =
    await Promise.all([
      getContact(supabase, membership.organizationId, id),
      // Final Major Product Build: full org contact list, needed only for
      // CreateEstimateButton's own ContactPicker (the same dialog /estimates
      // itself already fetches this for) - not used for anything else on
      // this page.
      getContacts(supabase, membership.organizationId),
      getContactRelationshipCounts(supabase, membership.organizationId, id),
      // Phase 3 (W2): this person's own records, read by contact - never the whole
      // organization's lists filtered in memory (which also stopped at 1,000 rows).
      getContactLeads(supabase, membership.organizationId, id),
      getAppointmentsForContact(supabase, membership.organizationId, id),
      getContactEstimates(supabase, membership.organizationId, id),
      getContactConversations(supabase, membership.organizationId, id),
      getContactJobs(supabase, membership.organizationId, id),
      getCustomerLifecycle(supabase, membership.organizationId, id),
      getOpenOpportunities(supabase, membership.organizationId),
      getOrganizationTimezone(supabase, membership.organizationId),
      // Phase 1B-4: this person's own invoices (a real contact-scoped read,
      // mirroring getContactEstimates) - number, status, balance due and
      // overdue only; notes and internal ids are never rendered here.
      getContactInvoices(supabase, membership.organizationId, id),
      // Phase 2-13 (§3): this person's conversations waiting on the business.
      getWaitingConversationIds(supabase, membership.organizationId, { contactId: id }),
    ]);

  if (!contact) {
    return (
      <div className={`${PAGE_CONTAINER_CLASS} gap-8 ${PAGE_MAX_WIDTH_CLASS}`}>
        <EmptyState
          icon={FileX2}
          title="Person not found"
          description="This person may have been deleted, or the link is incorrect."
          action={
            <Link href="/people" className="text-sm font-medium text-ink hover:underline">
              Back to People
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
  const jobIds = jobs.map((job) => job.id);

  // P0 A4: the TEST-only follow-up panel under each lead - the same three
  // conditions as Simulate Customer Reply (runFollowupNow re-checks them on
  // every submit). Production deployments skip both reads.
  type FollowupPanelRow = { id: string; lead_id: string; stage: FollowupStage; state: FollowupState; next_action_at: string | null; attempt_count: number; paused_reason: string | null; exit_reason: string | null };
  const followupByLeadId = new Map<string, FollowupPanelRow>();
  // P0-B B2.8f: the same three conditions also show the TEST-only nurture/reactivation Run now under each lead.
  const testRunNowAvailable =
    leads.length > 0 &&
    isCustomerReplySimulationEnvironment() &&
    (membership.role === "owner" || membership.role === "admin") &&
    (await supabase.from("organizations").select("automation_mode").eq("id", membership.organizationId).maybeSingle()).data?.automation_mode === "test";
  if (testRunNowAvailable) {
    const { data: followupRows } = await supabase
      .from("followups")
      .select("id, lead_id, stage, state, next_action_at, attempt_count, paused_reason, exit_reason")
      .eq("organization_id", membership.organizationId)
      .in("lead_id", leads.map((lead) => lead.id));
    for (const row of (followupRows ?? []) as FollowupPanelRow[]) followupByLeadId.set(row.lead_id, row);
  }

  // One getLeadStageHistory call per lead (the same function
  // /leads/[id] already calls once) and one getMessages call per
  // conversation (same as /leads/[id] and /contacts/[id] already do) -
  // reused as-is, never a new query shape, just called across this
  // person's full set of leads/conversations instead of a single one.
  // reviewRequests/referralRequests are a real, database-scoped
  // `.in("job_id", jobIds)` read (see getReviewRequestsForJobs's own
  // comment) rather than a full org fetch filtered in memory - this page
  // only needs this one person's own jobs' requests.
  const [stageHistories, conversationMessages, reviewRequests, referralRequests, lifecyclePolicy] = await Promise.all([
    Promise.all(leads.map((lead) => getLeadStageHistory(supabase, membership.organizationId, lead.id))),
    Promise.all(conversations.map((conversation) => getMessages(supabase, membership.organizationId, conversation.id))),
    getReviewRequestsForJobs(supabase, membership.organizationId, jobIds),
    getReferralRequestsForJobs(supabase, membership.organizationId, jobIds),
    loadLifecyclePolicy(supabase, membership.organizationId),
  ]);
  const stageHistoryByLeadId = new Map(leads.map((lead, index) => [lead.id, stageHistories[index]]));
  const messages = conversationMessages.flat();

  const timeline = buildPersonTimeline({ leads, stageHistoryByLeadId, appointments, estimates, jobs, messages, reviewRequests, referralRequests, timeZone });
  // Final Batch 3: from the canonical lifecycle of this person's own rows (lib/people/next-step.ts).
  const nextStep = findPersonNextStep({
    contactId: contact.id,
    leads,
    appointments,
    estimates,
    jobs,
    invoices,
    messages,
    reviewRequests,
    referralRequests,
    policy: lifecyclePolicy,
    conversations,
    waitingConversationIds: waiting.ids,
    timeZone,
    jobsEnabled: membership.vertical === "contractor",
  });
  const today = calendarDateInTimeZone(new Date(), timeZone ?? "UTC");

  const openLeadCount = leads.filter((lead) => lead.status !== "won" && lead.status !== "lost").length;
  // Finalization pass, money-truth audit: this header stat used to sum
  // `estimated_value ?? 0` with no disclosure that some leads have no value
  // entered - unlike its sibling on /opportunities (opportunities-list.tsx's
  // own "N with unknown value, not counted above" line) and unlike the
  // ALREADY-CORRECT identical stat on /contacts/[id]/page.tsx, which uses
  // this exact helper. Reusing it here, rather than a second inline
  // computation, is what makes the two pages agree.
  const openLeadValueSummary = summarizeOpenLeadValue(leads);
  const openLeadValueDisplay = formatOpenLeadValueDisplay(openLeadValueSummary, openLeadCount, formatCurrency);

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

  const mostRecentCompletedJob = jobs
    .filter((job) => job.status === "completed" && job.completed_at)
    .sort((a, b) => ((b.completed_at as string) < (a.completed_at as string) ? -1 : 1))[0] ?? null;
  const [reviewRequest, referralRequest] = mostRecentCompletedJob
    ? await Promise.all([
        getReviewRequestForJob(supabase, membership.organizationId, mostRecentCompletedJob.id),
        getReferralRequestForJob(supabase, membership.organizationId, mostRecentCompletedJob.id),
      ])
    : [null, null];

  const mostRecentOpenConversation = conversations.find((conversation) => conversation.status === "open") ?? conversations[0] ?? null;

  return (
    <div className="flex flex-1 flex-col">
      <DetailHeader
        eyebrow="Contact"
        backHref="/people"
        backLabel="Back to Contacts"
        avatar={
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-inset text-base font-medium text-ink-2 inset-ring inset-ring-line">
            {contactInitials(contact)}
          </span>
        }
        title={name}
        subtitle={contact.company_name ?? undefined}
        badges={<Badge tone={lifecycleStatusTone} icon={Sparkles}>{lifecycleStatus}</Badge>}
        action={
          // Phase 3's own spec: Call and Text immediately at the top,
          // alongside identity - not buried in a sidebar contact card.
          // Call and Text both hand off to the owner's own phone (tel:/sms:)
          // and only render when a real phone number exists - Trackpr has no
          // in-app compose, so Text must never imply it sends from here.
          // Without a phone, the most relevant real conversation is still
          // one click away, labeled for what that page actually does.
          <div className="flex items-center gap-2">
            {contact.phone ? (
              <a href={`tel:${contact.phone}`} className={`${primaryButtonAutoClass} gap-1.5`}>
                <Phone className="h-4 w-4" aria-hidden />
                Call
              </a>
            ) : null}
            {contact.phone ? (
              <a href={`sms:${contact.phone}`} className={`${secondaryButtonAutoClass} gap-1.5`}>
                <MessageCircle className="h-4 w-4" aria-hidden />
                Text
              </a>
            ) : mostRecentOpenConversation ? (
              <Link href={`/conversations/${mostRecentOpenConversation.id}`} className={`${secondaryButtonAutoClass} gap-1.5`}>
                <MessageCircle className="h-4 w-4" aria-hidden />
                Open conversation
              </Link>
            ) : null}
            {/* Final Major Product Build: Schedule links to the real
                calendar (never a fabricated per-contact booking dialog - the
                existing Schedule/calendar engine is explicitly out of scope
                for this pass) and Create Estimate opens the real, existing
                estimate dialog pre-filled with this contact - the two
                remaining actions from the product brief's own "Call, Text,
                Schedule, Create Estimate" set that weren't already here. */}
            <Link href="/schedule" className={`${secondaryButtonAutoClass} gap-1.5`}>
              <CalendarClock className="h-4 w-4" aria-hidden />
              Schedule
            </Link>
            <CreateEstimateButton contactId={contact.id} contacts={contacts} leads={allLeads} />
            {/* Reuses ContactActions (Edit/Delete) as-is - contacts/[id]'s
                own header action - so editing a person's details isn't a
                capability this new unified view drops relative to the old
                page it's meant to replace. */}
            <ContactActions contact={contact} />
          </div>
        }
        meta={
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
            {[
              { label: "Leads", value: String(relationshipCounts.leads), detail: undefined, icon: Flame },
              {
                // Phase 3 (W1): this is the sum of the person's open leads' values (summarizeOpenLeadValue) - named as such, matching Insights' "Open lead value".
                label: "Open lead value",
                value: openLeadValueDisplay,
                detail: openLeadValueSummary.unknownValueCount > 0 ? `${openLeadValueSummary.unknownValueCount} with unknown value` : undefined,
                icon: Wallet,
              },
              { label: "Appointments", value: String(relationshipCounts.appointments), detail: undefined, icon: CalendarCheck2 },
              { label: "Jobs", value: String(relationshipCounts.jobs), detail: undefined, icon: Briefcase },
            ].map((stat) => (
              <div key={stat.label}>
                <p className="flex items-center gap-1.5 text-xs font-medium text-ink-3">
                  <stat.icon className="h-3 w-3 shrink-0" aria-hidden />
                  {stat.label}
                </p>
                <p className="mt-1 text-xl font-semibold tabular-nums text-ink">{stat.value}</p>
                {stat.detail ? <p className="mt-0.5 text-xs text-ink-3">{stat.detail}</p> : null}
              </div>
            ))}
          </div>
        }
      />

      <div className={`${PAGE_CONTAINER_CLASS} gap-6 ${PAGE_MAX_WIDTH_CLASS}`}>
        {nextStep ? (
          <div
            className={`flex flex-wrap items-center justify-between gap-4 rounded-lg border px-5 py-4 ${
              nextStep.attention ? "border-warning-border bg-warning-muted" : "border-line bg-surface"
            }`}
          >
            <div className="flex items-center gap-3">
              <span
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                  nextStep.attention ? "bg-warning-muted text-warning-text" : "bg-accent-muted text-accent-text"
                }`}
              >
                {nextStep.attention ? <AlertCircle className="h-4 w-4" aria-hidden /> : <ArrowRight className="h-4 w-4" aria-hidden />}
              </span>
              <div>
                <p className="text-xs font-medium text-ink-3">What happens next</p>
                <p className="text-sm font-semibold text-ink">{nextStep.label}</p>
                {nextStep.detail ? <p className="text-xs text-ink-3">{nextStep.detail}</p> : null}
              </div>
            </div>
            <Link href={nextStep.href} className="shrink-0 text-sm font-medium text-ink hover:underline">
              View
            </Link>
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:gap-8">
          <div className="flex flex-col gap-6 lg:col-span-2">
            <div>
              <h2 className={cardTitleClass}>What happened</h2>
              <p className={`mt-1 ${pageDescriptionClass}`}>Everything that&apos;s happened with this person, most recent first.</p>
              {timeline.length === 0 ? (
                <p className="mt-3 text-sm text-ink-3">No activity recorded yet.</p>
              ) : (
                <ul className="mt-3 divide-y divide-line">
                  {timeline.map((event) => {
                    const EventIcon = event.icon;
                    return (
                      <li key={event.id} className="flex items-start gap-3 py-2.5">
                        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-inset text-ink-3">
                          <EventIcon className="h-3.5 w-3.5" aria-hidden />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline justify-between gap-3">
                            <span className="text-sm font-medium text-ink">{event.label}</span>
                            {/* Final Batch 3: when it happened, from the event's own stored timestamp. */}
                            {(() => {
                              const stamp = formatTimelineTimestamp(event.at, timeZone);
                              return stamp ? (
                                <time dateTime={stamp.iso} title={`${stamp.date} ${stamp.time}`} className="shrink-0 text-xs tabular-nums text-ink-3">
                                  {stamp.date} · {stamp.time}
                                  {stamp.relative ? ` · ${stamp.relative}` : ""}
                                </time>
                              ) : null;
                            })()}
                          </span>
                          {event.detail ? <span className="block truncate text-xs text-ink-3">{event.detail}</span> : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="flex flex-col divide-y divide-line border-t border-line pt-6">
              <section className="pb-6">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <Flame className="h-4 w-4 text-ink-3" aria-hidden />
                  Leads
                </h2>
                {leads.length === 0 ? (
                  <p className="mt-2 text-sm text-ink-3">No leads for this person yet.</p>
                ) : (
                  <ul className="mt-1 divide-y divide-line">
                    {leads.map((lead) => (
                      <li key={lead.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
                        {/* Performance Pass A: /leads/:id only redirects (via /customers/:id) back to
                            /people/<the lead's contact> - this page - so link there directly. A lead
                            with no contact keeps the old link and its existing fallback. */}
                        <Link href={lead.contact_id ? `/people/${lead.contact_id}` : `/leads/${lead.id}`} className="flex min-w-0 flex-1 items-center justify-between gap-3 text-sm transition-colors hover:text-ink">
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-ink">{lead.service || "General inquiry"}</span>
                            <span className="block text-xs text-ink-3">{formatContactDate(lead.created_at)}</span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            <span className="text-sm font-medium tabular-nums text-ink-2">{lead.estimated_value != null ? formatCurrency(lead.estimated_value) : "—"}</span>
                            <Badge tone={LEAD_STATUS_TONE[lead.status]}>{LEAD_STATUS_LABELS[lead.status]}</Badge>
                          </span>
                        </Link>
                        {/* The retired /leads/[id] page was the only place an existing lead could be
                            edited (status, temperature, service, value) - its LeadActions now lives on
                            each lead row here instead, unchanged: Edit -> LeadDialog -> updateLead. */}
                        <LeadActions lead={lead} contacts={contacts} vertical={membership.vertical} />
                        {(() => {
                          const followup = followupByLeadId.get(lead.id);
                          return followup ? (
                            <div className="basis-full">
                              <FollowupRunNow
                                followupId={followup.id}
                                stateLabel={FOLLOWUP_STATE_LABELS[followup.state]}
                                touchesUsed={followup.attempt_count}
                                touchesTotal={touchCount(followup.stage)}
                                nextActionLabel={followup.state === "scheduled" && followup.next_action_at ? `Next touch ${formatRelativeTime(followup.next_action_at)}.` : null}
                                reason={followup.exit_reason ?? followup.paused_reason}
                                canRun={followup.state === "scheduled"}
                              />
                            </div>
                          ) : null;
                        })()}
                        {testRunNowAvailable && (lead.status === "lost" || lead.status === "new" || lead.status === "contacted" || lead.status === "qualified") ? (
                          <div className="basis-full">
                            <LeadTouchRunNow leadId={lead.id} automation={lead.status === "lost" ? "lost-lead-nurture" : "lead-reactivation"} />
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="py-6">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <MessagesSquare className="h-4 w-4 text-ink-3" aria-hidden />
                  Conversations
                </h2>
                {conversations.length === 0 ? (
                  <p className="mt-2 text-sm text-ink-3">No conversations with this person yet.</p>
                ) : (
                  <ul className="mt-1 divide-y divide-line">
                    {conversations.map((conversation) => (
                      <li key={conversation.id}>
                        <Link href={`/conversations/${conversation.id}`} className="flex items-center justify-between gap-3 py-2.5 text-sm transition-colors hover:text-ink">
                          <span className="flex items-center gap-2 text-ink-2">
                            <span className="font-medium">{CHANNEL_LABEL[conversation.channel] ?? conversation.channel}</span>
                            <span className="text-xs text-ink-3">Updated {formatContactDate(conversation.updated_at)}</span>
                          </span>
                          <Badge tone={conversation.status === "open" ? "info" : "neutral"}>{conversation.status === "open" ? "Open" : "Closed"}</Badge>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="py-6">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <CalendarClock className="h-4 w-4 text-ink-3" aria-hidden />
                  Appointments
                </h2>
                {appointments.length === 0 ? (
                  <p className="mt-2 text-sm text-ink-3">No appointments for this person yet.</p>
                ) : (
                  <ul className="mt-1 divide-y divide-line">
                    {appointments.map((appointment) => (
                      <li key={appointment.id}>
                        <Link href={`/appointments/${appointment.id}`} className="flex items-center justify-between gap-3 py-2.5 text-sm transition-colors hover:text-ink">
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-ink">{appointment.title}</span>
                            <span className="block text-xs text-ink-3">
                              {formatAppointmentDate(appointment.start_at, timeZone)} · {formatAppointmentTimeRange(appointment.start_at, appointment.end_at, timeZone)}
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
              </section>

              <section className="py-6">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <FileSearch className="h-4 w-4 text-ink-3" aria-hidden />
                  Estimates
                </h2>
                {estimates.length === 0 ? (
                  <p className="mt-2 text-sm text-ink-3">No estimates for this person yet.</p>
                ) : (
                  <ul className="mt-1 divide-y divide-line">
                    {estimates.map((estimate) => (
                      <li key={estimate.id}>
                        <Link href={`/estimates/${estimate.id}`} className="flex items-center justify-between gap-3 py-2.5 text-sm transition-colors hover:text-ink">
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-ink">{estimate.title}</span>
                            <span className="block text-xs text-ink-3">{formatContactDate(estimate.created_at)}</span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            <span className="text-sm font-medium tabular-nums text-ink-2">{estimate.amount != null ? formatCurrency(estimate.amount) : "—"}</span>
                            <Badge tone={ESTIMATE_STATUS_TONE[estimate.status]} icon={ESTIMATE_STATUS_ICON[estimate.status]}>
                              {ESTIMATE_STATUS_LABELS[estimate.status]}
                            </Badge>
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="pt-6">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <Briefcase className="h-4 w-4 text-ink-3" aria-hidden />
                  Jobs
                </h2>
                {jobs.length === 0 ? (
                  <p className="mt-2 text-sm text-ink-3">No jobs for this person yet.</p>
                ) : (
                  <ul className="mt-1 divide-y divide-line">
                    {jobs.map((job) => (
                      <li key={job.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-ink">{job.title}</span>
                          <span className="block text-xs text-ink-3">{formatContactDate(job.created_at)}</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          <span className="text-sm font-medium tabular-nums text-ink-2">{job.amount != null ? formatCurrency(job.amount) : "—"}</span>
                          <Badge tone={JOB_STATUS_TONE[job.status]} icon={JOB_STATUS_ICON[job.status]}>
                            {JOB_STATUS_LABELS[job.status]}
                          </Badge>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Phase 1B-4: invoices for this person - the same figures the
                  Money Invoices tab shows per row (number, status, balance
                  due, overdue), each linking to the invoice page. Balance
                  is the database's own balance_due; overdue is derived
                  against today in the organization's timezone. */}
              <section className="pt-6">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <Receipt className="h-4 w-4 text-ink-3" aria-hidden />
                  Invoices
                </h2>
                {invoices.length === 0 ? (
                  <p className="mt-2 text-sm text-ink-3">No invoices for this person yet.</p>
                ) : (
                  <ul className="mt-1 divide-y divide-line">
                    {invoices.map((invoice) => {
                      const overdue = isOverdue({ status: invoice.status, dueDate: invoice.due_date }, today);
                      return (
                        <li key={invoice.id}>
                          <Link href={`/invoices/${invoice.id}`} className="flex items-center justify-between gap-3 py-2.5 text-sm transition-colors hover:text-ink">
                            <span className="min-w-0">
                              <span className="block truncate font-medium text-ink">
                                <span className="text-ink-3">{formatInvoiceNumber(invoice.number)}</span> · {invoice.title}
                              </span>
                              <span className="block text-xs text-ink-3">
                                {invoice.status === "void" ? formatMoney(invoice.total) : `${formatMoney(invoice.balance_due)} due`}
                                {invoice.due_date && invoice.status !== "void" && invoice.status !== "paid" ? ` · due ${formatContactDate(`${invoice.due_date}T12:00:00Z`)}` : ""}
                              </span>
                            </span>
                            <span className="flex shrink-0 items-center gap-2">
                              {overdue ? <Badge tone="danger">Overdue</Badge> : null}
                              <Badge tone={INVOICE_STATUS_TONE[invoice.status]} icon={INVOICE_STATUS_ICON[invoice.status]}>
                                {INVOICE_STATUS_LABELS[invoice.status]}
                              </Badge>
                            </span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </div>
          </div>

          <div className="flex flex-col gap-6">
            <Panel>
              <div className="flex items-center justify-between gap-3">
                <h2 className={subsectionTitleClass}>Customer intelligence</h2>
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
                          <span className="ml-1.5 text-xs font-normal text-ink-3">{formatCurrency(lifecycle.averageKnownCompletedJobValue)} average</span>
                        ) : null}
                      </dd>
                    </div>
                    <div>
                      <dt className={detailLabelClass}>Last completed job</dt>
                      <dd className={detailValueClass}>
                        {formatContactDate(lifecycle.lastCompletedJobAt as string)}
                        {lifecycle.daysSinceLastCompletedJob != null ? (
                          <span className="ml-1.5 text-xs font-normal text-ink-3">{lifecycle.daysSinceLastCompletedJob} days ago</span>
                        ) : null}
                      </dd>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-ink-3">No completed jobs yet.</p>
                )}
                {openOpportunities.length > 0 ? (
                  <div>
                    <dt className={detailLabelClass}>Open opportunities</dt>
                    <dd className={`${detailValueClass} space-y-1`}>
                      {openOpportunities.map((opportunity) => (
                        <span key={opportunity.id} className="block text-sm font-normal text-ink-2">
                          {OPPORTUNITY_TYPE_LABEL[opportunity.type]}
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

            {contact.notes ? (
              <Panel>
                <h2 className={subsectionTitleClass}>Notes</h2>
                <p className="mt-3 whitespace-pre-wrap text-sm text-ink-2">{contact.notes}</p>
              </Panel>
            ) : null}

            <Panel>
              <h2 className={subsectionTitleClass}>Details</h2>
              <dl className="mt-3 space-y-3">
                {infoFields.map((field) => (
                  <div key={field.label}>
                    <dt className={detailLabelClass}>{field.label}</dt>
                    <dd className={detailValueClass}>{field.value}</dd>
                  </div>
                ))}
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
