import Link from "next/link";
import { redirect } from "next/navigation";
import {
  CalendarClock,
  FileSearch,
  MessagesSquare,
  Sparkles,
  Flame,
  UserPlus,
  Send,
  MessageCircle,
  ArrowRightLeft,
  Briefcase,
  ArrowRight,
  AlertCircle,
  Ban,
  type LucideIcon,
} from "lucide-react";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getContacts } from "@/lib/contacts/queries";
import { getLead } from "@/lib/leads/queries";
import { getAppointments } from "@/lib/appointments/queries";
import { getEstimates } from "@/lib/estimates/queries";
import { getConversations, getMessages, type Message } from "@/lib/conversations/queries";
import { getJobs } from "@/lib/jobs/queries";
import { getLeadStageHistory } from "@/lib/automation/lead-stage-history";
import {
  STATUS_LABELS as APPOINTMENT_STATUS_LABELS,
  formatAppointmentDate,
  formatAppointmentTimeRange,
} from "@/lib/appointments/format";
import { STATUS_LABELS as ESTIMATE_STATUS_LABELS } from "@/lib/estimates/format";
import { STATUS_LABELS as JOB_STATUS_LABELS } from "@/lib/jobs/format";
import { CONVERSATION_CHANNELS } from "@/lib/conversations/queries";
import { contactDisplayName, contactInitials, formatContactDate } from "@/lib/contacts/format";
import { formatCurrency, formatRelativeTime } from "@/lib/dashboard/format";
import { getOrganizationTimezone } from "@/lib/settings/queries";
import { STATUS_LABELS, TEMPERATURE_LABELS } from "@/lib/leads/format";
import { detailLabelClass, detailValueClass, subsectionTitleClass, sectionLabelClass } from "@/lib/ui/typography";
import { Badge } from "@/lib/ui/badge";
import { EmptyState } from "@/lib/ui/empty-state";
import { SectionCard, Panel } from "@/lib/ui/section-card";
import { DetailHeader } from "@/lib/ui/detail-header";
import { LEAD_STATUS_TONE, LEAD_TEMPERATURE_TONE } from "../_components/lead-status";
import { APPOINTMENT_STATUS_TONE, APPOINTMENT_STATUS_ICON } from "../../appointments/_components/status";
import { ESTIMATE_STATUS_TONE, ESTIMATE_STATUS_ICON } from "../../estimates/_components/status";
import { JOB_STATUS_TONE, JOB_STATUS_ICON } from "../../jobs/_components/status";
import { LeadActions } from "./_components/lead-actions";

const CHANNEL_LABEL = Object.fromEntries(CONVERSATION_CHANNELS.map((item) => [item.value, item.label]));

type TimelineEvent = {
  id: string;
  at: string;
  icon: LucideIcon;
  label: string;
  detail?: string;
};

function truncate(text: string, max = 90): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

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

  const [lead, contacts, allAppointments, allEstimates, allConversations, allJobs, stageHistory, timeZone] = await Promise.all([
    getLead(supabase, membership.organizationId, id),
    getContacts(supabase, membership.organizationId),
    getAppointments(supabase, membership.organizationId),
    getEstimates(supabase, membership.organizationId),
    getConversations(supabase, membership.organizationId),
    getJobs(supabase, membership.organizationId),
    getLeadStageHistory(supabase, membership.organizationId, id),
    // Trackpr 2.0, Launch Certification QA fix: same fix as
    // app/(app)/contacts/[id]/page.tsx - formatAppointmentDate/
    // formatAppointmentTimeRange below need the organization's real
    // timezone, or they silently fall back to the server runtime's default
    // (UTC), rendering a real appointment several hours off from what
    // /appointments and /schedule already show correctly.
    getOrganizationTimezone(supabase, membership.organizationId),
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
  // Q8 (pre-launch lead-leak audit): leads.ai_score is never written anywhere
  // in this codebase (confirmed by a full-repo audit) - always null, so a
  // "Score" row here would always be dead UI, never a real signal a
  // contractor could act on. Only the summary is ever real.
  const hasAiInsight = Boolean(lead.ai_summary);

  const appointments = allAppointments
    .filter((appointment) => appointment.lead_id === lead.id)
    .sort((a, b) => new Date(b.start_at).getTime() - new Date(a.start_at).getTime());
  const estimates = allEstimates
    .filter((estimate) => estimate.lead_id === lead.id)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const conversations = allConversations
    .filter((conversation) => conversation.lead_id === lead.id)
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  const job = allJobs.find((candidate) => candidate.lead_id === lead.id) ?? null;

  // Real message history for this lead's conversation(s) only - reuses
  // getMessages exactly as the Conversations page itself calls it, once per
  // conversation (typically just one). Feeds both the "What happened"
  // timeline and the "Conversation" section's latest-message preview below;
  // no separate summarization or new query.
  const conversationMessages = await Promise.all(
    conversations.map((conversation) => getMessages(supabase, membership.organizationId, conversation.id)),
  );
  const messages: Message[] = conversationMessages.flat();

  const now = new Date().getTime();

  // "What happened" - a real, chronological event feed built only from
  // timestamps that actually exist (lead.created_at, appointment/estimate/
  // job creation, estimates.sent_at/responded_at, message.created_at,
  // and now - Growth System Completion Pass 2, Part 1 - real lead-stage
  // transitions from lead_stage_history). The first history entry
  // (previousStatus: null) is the lead's own creation, already covered by
  // the "Lead created" entry below - only genuine transitions are added
  // here, never a duplicate of it.
  const timeline: TimelineEvent[] = [
    {
      id: `lead-${lead.id}`,
      at: lead.created_at,
      icon: UserPlus,
      label: "Lead created",
      detail: lead.source ? `via ${lead.source}` : undefined,
    },
    ...stageHistory
      .filter((entry) => entry.previousStatus !== null)
      .map((entry) => ({
        id: `stage-${entry.id}`,
        at: entry.changedAt,
        icon: ArrowRightLeft,
        label: `${STATUS_LABELS[entry.previousStatus!]} → ${STATUS_LABELS[entry.newStatus]}`,
        detail: entry.source === "automation" ? "Automatic" : "Updated by staff",
      })),
    ...appointments.map((appointment) => ({
      id: `apt-${appointment.id}`,
      at: appointment.created_at,
      icon: CalendarClock,
      label: "Appointment scheduled",
      detail: `${appointment.title} · ${formatAppointmentDate(appointment.start_at, timeZone)}`,
    })),
    ...estimates.flatMap((estimate) => {
      const events: TimelineEvent[] = [];
      if (estimate.sent_at) {
        events.push({
          id: `est-sent-${estimate.id}`,
          at: estimate.sent_at,
          icon: Send,
          label: "Estimate sent",
          detail: estimate.amount != null ? formatCurrency(estimate.amount) : estimate.title,
        });
      }
      if (estimate.responded_at) {
        events.push({
          id: `est-responded-${estimate.id}`,
          at: estimate.responded_at,
          icon: estimate.status === "accepted" ? ArrowRightLeft : Ban,
          label: estimate.status === "accepted" ? "Estimate accepted" : estimate.status === "declined" ? "Estimate declined" : "Estimate responded to",
          detail: estimate.title,
        });
      }
      return events;
    }),
    ...(job
      ? [
          {
            id: `job-${job.id}`,
            at: job.created_at,
            icon: Briefcase,
            label: "Job created",
            detail: job.title,
          },
        ]
      : []),
    ...messages.map((message) => ({
      id: `msg-${message.id}`,
      at: message.created_at,
      icon: message.direction === "inbound" ? MessageCircle : Send,
      label:
        message.direction === "inbound"
          ? "Customer replied"
          : message.sender_type === "ai"
            ? "Automated follow-up sent"
            : message.sender_type === "system"
              ? "System message sent"
              : "You sent a message",
      detail: truncate(message.body),
    })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  // "What happens next" - derived, never invented, from the exact same
  // real state already on this page. Priority order matches urgency: a
  // conversation waiting on a human outranks a scheduled appointment, which
  // outranks a pending estimate, which outranks a plain follow-up nudge.
  const waitingConversation = conversations.find((conversation) => conversation.status === "open" && !conversation.ai_enabled);
  const nextAppointment = appointments.find(
    (appointment) => (appointment.status === "scheduled" || appointment.status === "confirmed") && new Date(appointment.start_at).getTime() > now,
  );
  const pendingEstimate = estimates.find((estimate) => estimate.status === "sent");

  const nextStep: { label: string; detail?: string; href: string; attention: boolean } | null = waitingConversation
    ? {
        label: "Needs your attention",
        detail: "A conversation is waiting for a reply.",
        href: `/conversations/${waitingConversation.id}`,
        attention: true,
      }
    : nextAppointment
      ? {
          label: "Appointment scheduled",
          detail: `${formatAppointmentDate(nextAppointment.start_at, timeZone)} · ${formatAppointmentTimeRange(nextAppointment.start_at, nextAppointment.end_at, timeZone)}`,
          href: `/appointments/${nextAppointment.id}`,
          attention: false,
        }
      : pendingEstimate
        ? {
            label: "Estimate awaiting response",
            detail: pendingEstimate.title,
            href: `/estimates/${pendingEstimate.id}`,
            attention: false,
          }
        : lead.status === "won"
          ? job
            ? { label: "Job in progress", detail: job.title, href: `/jobs/${job.id}`, attention: false }
            : null
          : lead.status === "lost"
            ? null
            : { label: "Follow up with customer", detail: "No appointment or estimate in motion yet.", href: "/leads", attention: true };

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
        action={<LeadActions lead={lead} contacts={contacts} vertical={membership.vertical} />}
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
        {/* WHAT HAPPENS NEXT - the single most actionable fact on this page,
            derived only from real lead/appointment/estimate/conversation
            state (see the priority chain above) - never invented. */}
        {nextStep ? (
          <div
            className={`flex flex-wrap items-center justify-between gap-4 rounded-xl border px-5 py-4 ${
              nextStep.attention ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-white shadow-sm"
            }`}
          >
            <div className="flex items-center gap-3">
              <span
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                  nextStep.attention ? "bg-amber-100 text-amber-700" : "bg-accent-muted text-accent-text"
                }`}
              >
                {nextStep.attention ? <AlertCircle className="h-4 w-4" aria-hidden /> : <ArrowRight className="h-4 w-4" aria-hidden />}
              </span>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">What happens next</p>
                <p className="text-sm font-semibold text-slate-900">{nextStep.label}</p>
                {nextStep.detail ? <p className="text-xs text-slate-500">{nextStep.detail}</p> : null}
              </div>
            </div>
            <Link href={nextStep.href} className="shrink-0 text-sm font-medium text-slate-900 hover:underline">
              View
            </Link>
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:gap-8">
          {/* MAIN COLUMN: what happened, the conversation, then related records */}
          <div className="flex flex-col gap-6 lg:col-span-2">
            <SectionCard title="What happened" description="Everything that's happened on this opportunity, most recent first.">
              {timeline.length === 0 ? (
                <p className="text-sm text-slate-500">No activity recorded yet.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {timeline.map((event) => {
                    const EventIcon = event.icon;
                    return (
                      <li key={event.id} className="flex items-start gap-3 py-2.5">
                        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500">
                          <EventIcon className="h-3.5 w-3.5" aria-hidden />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline justify-between gap-3">
                            <span className="text-sm font-medium text-slate-900">{event.label}</span>
                            <span className="shrink-0 text-xs tabular-nums text-slate-400">{formatRelativeTime(event.at)}</span>
                          </span>
                          {event.detail ? <span className="block truncate text-xs text-slate-500">{event.detail}</span> : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </SectionCard>

            <SectionCard title="Conversation" description="Customer communication for this lead." icon={MessagesSquare}>
              {conversations.length === 0 ? (
                <p className="text-sm text-slate-500">No conversation yet for this lead.</p>
              ) : (
                <div className="space-y-4">
                  {conversations.slice(0, 1).map((conversation) => {
                    const latestMessage = [...messages]
                      .filter((message) => message.conversation_id === conversation.id)
                      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
                    return (
                      <div key={conversation.id}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <Badge tone={conversation.status === "open" ? "info" : "neutral"}>
                              {conversation.status === "open" ? "Open" : "Closed"}
                            </Badge>
                            {!conversation.ai_enabled ? <Badge tone="warning">Waiting on you</Badge> : null}
                            <span className="text-xs text-slate-400">{CHANNEL_LABEL[conversation.channel] ?? conversation.channel}</span>
                          </div>
                          <Link href={`/conversations/${conversation.id}`} className="text-xs font-medium text-slate-600 hover:text-slate-900">
                            View full conversation
                          </Link>
                        </div>
                        {latestMessage ? (
                          <div className="mt-3 rounded-lg bg-slate-50 px-4 py-3">
                            <p className="text-xs font-medium text-slate-500">
                              {latestMessage.direction === "inbound"
                                ? "Customer"
                                : latestMessage.sender_type === "ai"
                                  ? "Automated reply"
                                  : "You"}{" "}
                              · {formatRelativeTime(latestMessage.created_at)}
                            </p>
                            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{latestMessage.body}</p>
                          </div>
                        ) : (
                          <p className="mt-3 text-sm text-slate-500">No messages yet in this conversation.</p>
                        )}
                      </div>
                    );
                  })}
                  {conversations.length > 1 ? (
                    <p className="text-xs text-slate-400">
                      Plus {conversations.length - 1} earlier conversation{conversations.length - 1 === 1 ? "" : "s"} for this lead.
                    </p>
                  ) : null}
                </div>
              )}
            </SectionCard>

            <SectionCard title="Related" description="Appointments, estimates, and the job for this opportunity.">
              <div className="space-y-5">
                <div>
                  <h3 className={sectionLabelClass}>Appointments</h3>
                  {appointments.length === 0 ? (
                    <p className="mt-2 text-sm text-slate-500">No appointments scheduled for this lead.</p>
                  ) : (
                    <ul className="mt-1 divide-y divide-slate-100">
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
                </div>

                <div>
                  <h3 className={sectionLabelClass}>Estimates</h3>
                  {estimates.length === 0 ? (
                    <p className="mt-2 text-sm text-slate-500">No estimates prepared for this lead yet.</p>
                  ) : (
                    <ul className="mt-1 divide-y divide-slate-100">
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
                </div>

                <div>
                  <h3 className={sectionLabelClass}>Job</h3>
                  {job ? (
                    <Link
                      href={`/jobs/${job.id}`}
                      className="mt-1 flex items-center justify-between gap-3 py-2.5 text-sm transition-colors hover:text-slate-900"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-slate-900">{job.title}</span>
                        <span className="block text-xs text-slate-500">{formatContactDate(job.created_at)}</span>
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="text-sm font-medium tabular-nums text-slate-700">
                          {job.amount != null ? formatCurrency(job.amount) : "—"}
                        </span>
                        <Badge tone={JOB_STATUS_TONE[job.status]} icon={JOB_STATUS_ICON[job.status]}>
                          {JOB_STATUS_LABELS[job.status]}
                        </Badge>
                      </span>
                    </Link>
                  ) : (
                    <p className="mt-2 text-sm text-slate-500">No job created for this lead yet.</p>
                  )}
                </div>
              </div>
            </SectionCard>
          </div>

          {/* SIDEBAR: contact info, source/timestamps, then AI qualification -
              genuinely useful, but secondary metadata rather than the page's
              opening move. */}
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

            <SectionCard title="Lead score" description="AI scoring and summary for this opportunity." icon={Sparkles}>
              {hasAiInsight ? (
                <div className="space-y-3">
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
          </div>
        </div>
      </div>
    </div>
  );
}
