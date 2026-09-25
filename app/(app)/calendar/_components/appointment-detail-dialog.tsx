"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { Phone, Mail, ExternalLink } from "lucide-react";
import { Dialog, DialogTitle } from "@/lib/ui/dialog";
import { Badge } from "@/lib/ui/badge";
import { detailLabelClass, detailValueClass } from "@/lib/ui/typography";
import type { Appointment } from "@/lib/appointments/queries";
import { formatAppointmentDate, formatAppointmentDuration, formatAppointmentTimeRange, STATUS_LABELS } from "@/lib/appointments/format";
import { contactDisplayName } from "@/lib/contacts/format";
import { APPOINTMENT_STATUS_TONE, APPOINTMENT_STATUS_ICON } from "../../appointments/_components/status";
import { AppointmentQuickActions } from "./appointment-quick-actions";

/**
 * Pass 2 (Native Calendar System, Phase 9): the calendar's own compact
 * "open an appointment" surface - customer/service/time/notes context plus
 * the one-click actions, without turning into a second, competing detail
 * page. A "View full details" link always leads to the real appointment
 * page (/appointments/[id]) for anything this dialog deliberately leaves
 * out (estimate/job links, created/updated history).
 */
export function AppointmentDetailDialog({ appointment, timeZone, onClose }: { appointment: Appointment; timeZone?: string; onClose: () => void }) {
  const router = useRouter();
  const customerName = appointment.contact ? contactDisplayName(appointment.contact) : "No contact";

  return (
    <Dialog onClose={onClose} className="max-h-[90vh] max-w-md overflow-y-auto" labelledBy="appointment-detail-title">
      <div className="flex items-start justify-between gap-3">
        <DialogTitle id="appointment-detail-title">{appointment.title}</DialogTitle>
        <Badge tone={APPOINTMENT_STATUS_TONE[appointment.status]} icon={APPOINTMENT_STATUS_ICON[appointment.status]}>
          {STATUS_LABELS[appointment.status]}
        </Badge>
      </div>

      <div className="mt-4 space-y-4">
        <div>
          <p className={detailLabelClass}>When</p>
          <p className={detailValueClass}>{formatAppointmentDate(appointment.start_at, timeZone)}</p>
          <p className="mt-0.5 text-sm text-slate-600">
            {formatAppointmentTimeRange(appointment.start_at, appointment.end_at, timeZone)} · {formatAppointmentDuration(appointment.start_at, appointment.end_at)}
          </p>
        </div>

        <div>
          <p className={detailLabelClass}>Customer</p>
          <p className={detailValueClass}>{customerName}</p>
          <div className="mt-1 flex flex-col gap-0.5 text-sm text-slate-500">
            {appointment.contact?.phone ? (
              <span className="inline-flex items-center gap-1.5">
                <Phone aria-hidden className="h-3.5 w-3.5" />
                {appointment.contact.phone}
              </span>
            ) : null}
            {appointment.contact?.email ? (
              <span className="inline-flex items-center gap-1.5">
                <Mail aria-hidden className="h-3.5 w-3.5" />
                {appointment.contact.email}
              </span>
            ) : null}
          </div>
        </div>

        {appointment.lead?.service ? (
          <div>
            <p className={detailLabelClass}>Service</p>
            <p className={detailValueClass}>{appointment.lead.service}</p>
          </div>
        ) : null}

        {appointment.notes ? (
          <div>
            <p className={detailLabelClass}>Notes</p>
            <p className="whitespace-pre-wrap text-sm text-slate-700">{appointment.notes}</p>
          </div>
        ) : null}

        <AppointmentQuickActions
          appointment={appointment}
          timeZone={timeZone}
          onChanged={() => {
            router.refresh();
            onClose();
          }}
        />

        <Link href={`/appointments/${appointment.id}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900">
          View full details
          <ExternalLink aria-hidden className="h-3.5 w-3.5" />
        </Link>
      </div>
    </Dialog>
  );
}
