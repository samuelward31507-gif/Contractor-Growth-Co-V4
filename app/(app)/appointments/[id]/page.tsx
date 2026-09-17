import Link from "next/link";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getContacts } from "@/lib/contacts/queries";
import { getLeads } from "@/lib/leads/queries";
import { getAppointment } from "@/lib/appointments/queries";
import { contactDisplayName, contactInitials, formatContactDate } from "@/lib/contacts/format";
import { STATUS_LABELS as LEAD_STATUS_LABELS, TEMPERATURE_LABELS } from "@/lib/leads/format";
import { formatCurrency } from "@/lib/dashboard/format";
import {
  formatAppointmentDate,
  formatAppointmentDuration,
  formatAppointmentTimeRange,
} from "@/lib/appointments/format";
import { getOrganizationTimezone } from "@/lib/settings/queries";
import { cardClass, cardHeaderClass, cardTitleClass } from "@/lib/ui/card";
import { Icon } from "../../_components/icon";
import { AppointmentStatusBadge } from "../_components/status-badge";
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
    <div className="flex flex-1 flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <Link
        href="/appointments"
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-slate-500 transition-colors hover:text-slate-900"
      >
        <Icon name="arrow-left" className="h-4 w-4" />
        Back to Appointments
      </Link>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">{appointment.title}</h1>
          <p className="text-sm text-slate-500">{customerName}</p>
          <div className="mt-1.5">
            <AppointmentStatusBadge status={appointment.status} />
          </div>
        </div>
        <AppointmentActions appointment={appointment} contacts={contacts} leads={leads} />
      </div>

      <div className={cardClass}>
        <div className={cardHeaderClass}>
          <h2 className={cardTitleClass}>Appointment</h2>
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 px-5 py-5 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Date</dt>
            <dd className="mt-1 text-sm text-slate-900">{formatAppointmentDate(appointment.start_at, timeZone)}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Time</dt>
            <dd className="mt-1 text-sm text-slate-900">
              {formatAppointmentTimeRange(appointment.start_at, appointment.end_at, timeZone)}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Duration</dt>
            <dd className="mt-1 text-sm text-slate-900">
              {formatAppointmentDuration(appointment.start_at, appointment.end_at)}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Status</dt>
            <dd className="mt-1">
              <AppointmentStatusBadge status={appointment.status} />
            </dd>
          </div>
        </dl>
        {appointment.notes ? (
          <div className="border-t border-slate-100 px-5 py-5">
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Notes</dt>
            <dd className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{appointment.notes}</dd>
          </div>
        ) : null}
      </div>

      {appointment.contact ? (
        <div className={cardClass}>
          <div className={cardHeaderClass}>
            <h2 className={cardTitleClass}>Customer</h2>
            <Link
              href={`/contacts/${appointment.contact.id}`}
              className="text-sm font-medium text-slate-600 hover:text-slate-900"
            >
              View contact
            </Link>
          </div>
          <div className="flex items-center gap-4 px-5 py-5">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-slate-900 text-sm font-semibold text-white">
              {contactInitials(appointment.contact)}
            </span>
            <dl className="grid flex-1 grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Name</dt>
                <dd className="mt-0.5 text-sm text-slate-900">{contactDisplayName(appointment.contact)}</dd>
              </div>
              {appointment.contact.company_name ? (
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Company</dt>
                  <dd className="mt-0.5 text-sm text-slate-900">{appointment.contact.company_name}</dd>
                </div>
              ) : null}
              {appointment.contact.phone ? (
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Phone</dt>
                  <dd className="mt-0.5 text-sm text-slate-900">{appointment.contact.phone}</dd>
                </div>
              ) : null}
              {appointment.contact.email ? (
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Email</dt>
                  <dd className="mt-0.5 text-sm text-slate-900">{appointment.contact.email}</dd>
                </div>
              ) : null}
            </dl>
          </div>
        </div>
      ) : null}

      {appointment.lead ? (
        <div className={cardClass}>
          <div className={cardHeaderClass}>
            <h2 className={cardTitleClass}>Lead</h2>
            <Link
              href={`/leads/${appointment.lead.id}`}
              className="text-sm font-medium text-slate-600 hover:text-slate-900"
            >
              View lead
            </Link>
          </div>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-4 px-5 py-5 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Service</dt>
              <dd className="mt-1 text-sm text-slate-900">{appointment.lead.service || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Source</dt>
              <dd className="mt-1 text-sm text-slate-900">{appointment.lead.source || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Temperature</dt>
              <dd className="mt-1 text-sm text-slate-900">{TEMPERATURE_LABELS[appointment.lead.temperature]}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Lead status</dt>
              <dd className="mt-1 text-sm text-slate-900">{LEAD_STATUS_LABELS[appointment.lead.status]}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Estimated value</dt>
              <dd className="mt-1 text-sm text-slate-900">
                {appointment.lead.estimated_value != null ? formatCurrency(appointment.lead.estimated_value) : "—"}
              </dd>
            </div>
          </dl>
        </div>
      ) : null}

      <p className="text-xs text-slate-400">
        Added {formatContactDate(appointment.created_at)}
        {appointment.updated_at !== appointment.created_at
          ? ` · Updated ${formatContactDate(appointment.updated_at)}`
          : ""}
      </p>
    </div>
  );
}
