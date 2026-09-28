import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertCircle, ArrowRight, CalendarClock, Clock3, MessageCircle, Phone, Timer } from "lucide-react";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getContacts } from "@/lib/contacts/queries";
import { getContactLeads, getLeads } from "@/lib/leads/queries";
import { getAppointment } from "@/lib/appointments/queries";
import { getContactAppointments, getContactConversations } from "@/lib/conversations/queries";
import { getContactEstimates } from "@/lib/estimates/queries";
import { getContactJobs } from "@/lib/jobs/queries";
import { getContactInvoices } from "@/lib/invoices/queries";
import { findPersonNextStep } from "@/lib/people/next-step";
import { contactDisplayName, formatContactDate } from "@/lib/contacts/format";
import { STATUS_LABELS as LEAD_STATUS_LABELS, TEMPERATURE_LABELS } from "@/lib/leads/format";
import { formatCurrency } from "@/lib/dashboard/format";
import {
  formatAppointmentDate,
  formatAppointmentDuration,
  formatAppointmentTimeRange,
  STATUS_LABELS as APPOINTMENT_STATUS_LABELS,
} from "@/lib/appointments/format";
import { getOrganizationTimezone } from "@/lib/settings/queries";
import { detailLabelClass, detailValueClass, subsectionTitleClass } from "@/lib/ui/typography";
import { Badge } from "@/lib/ui/badge";
import { SectionCard, Panel } from "@/lib/ui/section-card";
import { DetailHeader } from "@/lib/ui/detail-header";
import { primaryButtonAutoClass, secondaryButtonAutoClass } from "@/lib/ui/form";
import { APPOINTMENT_STATUS_TONE, APPOINTMENT_STATUS_ICON } from "../_components/status";
import { AppointmentActions } from "./_components/appointment-actions";

export default async function AppointmentDetailPage({ params }: PageProps<"/appointments/[id]">) {
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

  const [appointment, contacts, leads, timeZone] = await Promise.all([
    getAppointment(supabase, membership.organizationId, id),
    getContacts(supabase, membership.organizationId),
    getLeads(supabase, membership.organizationId),
    getOrganizationTimezone(supabase, membership.organizationId),
  ]);

  // Final Major Product Build: "what happens next" for this appointment's
  // own contact, scoped via the same targeted contact-id queries the Inbox
  // context panel uses (never a full org fetch) - satisfies the product
  // brief's "clicking an appointment should make it easy to understand
  // Customer, Job, Estimate, Conversation, Next step" without fabricating a
  // relationship the schema doesn't have (there is no appointment_id FK on
  // estimates/jobs, so this surfaces the contact's own real next step
  // rather than claiming a specific estimate/job "came from" this
  // appointment).
  const [contactLeads, contactEstimates, contactJobs, contactAppointments, contactConversations, contactInvoices] = appointment?.contact_id
    ? await Promise.all([
        getContactLeads(supabase, membership.organizationId, appointment.contact_id),
        getContactEstimates(supabase, membership.organizationId, appointment.contact_id),
        getContactJobs(supabase, membership.organizationId, appointment.contact_id),
        getContactAppointments(supabase, membership.organizationId, appointment.contact_id),
        getContactConversations(supabase, membership.organizationId, appointment.contact_id),
        // Phase 1B-4: the next step reads a completed job's live invoice.
        getContactInvoices(supabase, membership.organizationId, appointment.contact_id),
      ])
    : [[], [], [], [], [], []];

  const nextStep = appointment?.contact_id
    ? findPersonNextStep({ leads: contactLeads, appointments: contactAppointments, estimates: contactEstimates, jobs: contactJobs, conversations: contactConversations, invoices: contactInvoices, timeZone })
    : null;
  const mostRecentOpenConversation = contactConversations.find((conversation) => conversation.status === "open") ?? contactConversations[0] ?? null;

  if (!appointment) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <h1 className="text-lg font-semibold text-slate-900">Appointment not found</h1>
        <p className="text-sm text-slate-500">
          This appointment may have been deleted, or the link is incorrect.
        </p>
        <Link href="/appointments" className="mt-2 text-sm font-medium text-slate-900 hover:underline">
          Back to Appointments
        </Link>
      </div>
    );
  }

  const customerName = appointment.contact ? contactDisplayName(appointment.contact) : "No contact";

  return (
    <div className="flex flex-1 flex-col">
      {/*
        APPOINTMENT hierarchy: state -> customer -> timing -> activity. Date/
        time/duration are what a contractor actually opens this page to
        confirm, so they lead in the header's meta row instead of being the
        first thing inside a SectionCard below the fold.
      */}
      <DetailHeader
        eyebrow="Appointment"
        backHref="/appointments"
        backLabel="Back to Appointments"
        title={appointment.title}
        subtitle={customerName}
        badges={
          <Badge tone={APPOINTMENT_STATUS_TONE[appointment.status]} icon={APPOINTMENT_STATUS_ICON[appointment.status]}>
            {APPOINTMENT_STATUS_LABELS[appointment.status]}
          </Badge>
        }
        action={<AppointmentActions appointment={appointment} contacts={contacts} leads={leads} />}
        meta={
          <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
            <div>
              <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-slate-500">
                <CalendarClock className="h-3 w-3 shrink-0" aria-hidden />
                Date
              </p>
              <p className="mt-1 text-lg font-semibold text-slate-900">{formatAppointmentDate(appointment.start_at, timeZone)}</p>
            </div>
            <div>
              <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-slate-500">
                <Clock3 className="h-3 w-3 shrink-0" aria-hidden />
                Time
              </p>
              <p className="mt-1 text-lg font-semibold text-slate-900">
                {formatAppointmentTimeRange(appointment.start_at, appointment.end_at, timeZone)}
              </p>
            </div>
            <div>
              <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-slate-500">
                <Timer className="h-3 w-3 shrink-0" aria-hidden />
                Duration
              </p>
              <p className="mt-1 text-lg font-semibold text-slate-900">{formatAppointmentDuration(appointment.start_at, appointment.end_at)}</p>
            </div>
          </div>
        }
      />

      <div className="flex flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      {nextStep ? (
        <div
          className={`flex flex-wrap items-center justify-between gap-4 rounded-xl border px-5 py-4 ${
            nextStep.attention ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-white"
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
              <p className="text-[12.5px] font-medium text-slate-500">What happens next</p>
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
        <div className="flex flex-col gap-6 lg:col-span-2">
          {appointment.notes ? (
            <SectionCard title="Notes">
              <p className="whitespace-pre-wrap text-sm text-slate-700">{appointment.notes}</p>
            </SectionCard>
          ) : null}

          {appointment.lead ? (
            <SectionCard
              title="Lead"
              action={
                <Link href={`/leads/${appointment.lead.id}`} className="text-xs font-medium text-slate-600 hover:text-slate-900">
                  View lead
                </Link>
              }
            >
              <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
                <div>
                  <dt className={detailLabelClass}>Service</dt>
                  <dd className={detailValueClass}>{appointment.lead.service || "—"}</dd>
                </div>
                <div>
                  <dt className={detailLabelClass}>Lead status</dt>
                  <dd className={detailValueClass}>{LEAD_STATUS_LABELS[appointment.lead.status]}</dd>
                </div>
                <div>
                  <dt className={detailLabelClass}>Temperature</dt>
                  <dd className={detailValueClass}>{TEMPERATURE_LABELS[appointment.lead.temperature]}</dd>
                </div>
                <div>
                  <dt className={detailLabelClass}>Estimated value</dt>
                  <dd className={`${detailValueClass} tabular-nums`}>
                    {appointment.lead.estimated_value != null ? formatCurrency(appointment.lead.estimated_value) : "—"}
                  </dd>
                </div>
              </dl>
            </SectionCard>
          ) : null}
        </div>

        <div className="flex flex-col gap-6">
          {appointment.contact ? (
            <SectionCard
              title="Customer"
              action={
                <Link href={`/people/${appointment.contact.id}`} className="text-xs font-medium text-slate-600 hover:text-slate-900">
                  View contact
                </Link>
              }
            >
              <dl className="space-y-3">
                <div>
                  <dt className={detailLabelClass}>Name</dt>
                  <dd className={detailValueClass}>{contactDisplayName(appointment.contact)}</dd>
                </div>
                {appointment.contact.phone ? (
                  <div>
                    <dt className={detailLabelClass}>Phone</dt>
                    <dd className={detailValueClass}>{appointment.contact.phone}</dd>
                  </div>
                ) : null}
                {appointment.contact.email ? (
                  <div>
                    <dt className={detailLabelClass}>Email</dt>
                    <dd className={detailValueClass}>{appointment.contact.email}</dd>
                  </div>
                ) : null}
              </dl>
              <div className="mt-4 flex items-center gap-2">
                {appointment.contact.phone ? (
                  <a href={`tel:${appointment.contact.phone}`} className={`${primaryButtonAutoClass} gap-1.5`}>
                    <Phone className="h-4 w-4" aria-hidden />
                    Call
                  </a>
                ) : null}
                {mostRecentOpenConversation ? (
                  <Link href={`/conversations/${mostRecentOpenConversation.id}`} className={`${secondaryButtonAutoClass} gap-1.5`}>
                    <MessageCircle className="h-4 w-4" aria-hidden />
                    Text
                  </Link>
                ) : null}
              </div>
            </SectionCard>
          ) : null}

          <Panel>
            <h2 className={subsectionTitleClass}>Details</h2>
            <dl className="mt-3 space-y-3">
              {/* Pass 5B: only shown when there's something true to say -
                  matching this panel's own established "Last updated" rule
                  of never rendering a redundant/empty row. A confirmed
                  appointment shows when; an appointment still awaiting a
                  reply shows that instead; a plain scheduled appointment
                  with no request sent yet shows neither row. */}
              {appointment.confirmed_at ? (
                <div>
                  <dt className={detailLabelClass}>Confirmation</dt>
                  <dd className={detailValueClass}>Confirmed {formatContactDate(appointment.confirmed_at)}</dd>
                </div>
              ) : appointment.confirmation_requested_at && appointment.status === "scheduled" ? (
                <div>
                  <dt className={detailLabelClass}>Confirmation</dt>
                  <dd className={detailValueClass}>Requested {formatContactDate(appointment.confirmation_requested_at)} - no response yet</dd>
                </div>
              ) : null}
              <div>
                <dt className={detailLabelClass}>Added</dt>
                <dd className={detailValueClass}>{formatContactDate(appointment.created_at)}</dd>
              </div>
              {appointment.updated_at !== appointment.created_at ? (
                <div>
                  <dt className={detailLabelClass}>Last updated</dt>
                  <dd className={detailValueClass}>{formatContactDate(appointment.updated_at)}</dd>
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
