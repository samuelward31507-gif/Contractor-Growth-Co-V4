import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
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
  STATUS_LABELS as APPOINTMENT_STATUS_LABELS,
} from "@/lib/appointments/format";
import { getOrganizationTimezone } from "@/lib/settings/queries";
import { detailLabelClass, detailValueClass, subsectionTitleClass } from "@/lib/ui/typography";
import { Badge } from "@/lib/ui/badge";
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
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <Link
        href="/appointments"
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-slate-500 transition-colors hover:text-slate-900"
      >
        <ArrowLeft aria-hidden className="h-4 w-4" />
        Back to Appointments
      </Link>

      {/* IDENTITY + CURRENT STATE */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">{appointment.title}</h1>
          <p className="text-sm text-slate-500">{customerName}</p>
          <div className="mt-1.5">
            <Badge tone={APPOINTMENT_STATUS_TONE[appointment.status]} icon={APPOINTMENT_STATUS_ICON[appointment.status]}>
              {APPOINTMENT_STATUS_LABELS[appointment.status]}
            </Badge>
          </div>
        </div>
        <AppointmentActions appointment={appointment} contacts={contacts} leads={leads} />
      </div>

      <div className="border-t border-slate-200 pt-8">
        <h2 className={subsectionTitleClass}>Appointment</h2>
        <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
          <div>
            <dt className={detailLabelClass}>Date</dt>
            <dd className={detailValueClass}>{formatAppointmentDate(appointment.start_at, timeZone)}</dd>
          </div>
          <div>
            <dt className={detailLabelClass}>Time</dt>
            <dd className={detailValueClass}>
              {formatAppointmentTimeRange(appointment.start_at, appointment.end_at, timeZone)}
            </dd>
          </div>
          <div>
            <dt className={detailLabelClass}>Duration</dt>
            <dd className={detailValueClass}>{formatAppointmentDuration(appointment.start_at, appointment.end_at)}</dd>
          </div>
        </dl>
        {appointment.notes ? (
          <div className="mt-4">
            <dt className={detailLabelClass}>Notes</dt>
            <dd className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{appointment.notes}</dd>
          </div>
        ) : null}
      </div>

      {appointment.contact ? (
        <div className="border-t border-slate-200 pt-8">
          <div className="flex items-center justify-between">
            <h2 className={subsectionTitleClass}>Customer</h2>
            <Link
              href={`/contacts/${appointment.contact.id}`}
              className="text-sm font-medium text-slate-600 hover:text-slate-900"
            >
              View contact
            </Link>
          </div>
          <div className="mt-4 flex items-center gap-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-medium text-slate-600">
              {contactInitials(appointment.contact)}
            </span>
            <dl className="grid flex-1 grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-3">
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
          </div>
        </div>
      ) : null}

      {appointment.lead ? (
        <div className="border-t border-slate-200 pt-8">
          <div className="flex items-center justify-between">
            <h2 className={subsectionTitleClass}>Lead</h2>
            <Link
              href={`/leads/${appointment.lead.id}`}
              className="text-sm font-medium text-slate-600 hover:text-slate-900"
            >
              View lead
            </Link>
          </div>
          <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
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
              <dd className={detailValueClass}>
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
