import Link from "next/link";
import { cardClass, cardHeaderClass, cardTitleClass } from "@/lib/ui/card";
import { formatCurrency } from "@/lib/dashboard/format";
import { formatAppointmentDate, formatAppointmentTime, STATUS_LABELS as APPOINTMENT_STATUS_LABELS } from "@/lib/appointments/format";
import { STATUS_LABELS as LEAD_STATUS_LABELS, TEMPERATURE_LABELS } from "@/lib/leads/format";
import type { Conversation, RelevantAppointment } from "@/lib/conversations/queries";

export function ConversationContext({
  conversation,
  relevantAppointment,
}: {
  conversation: Conversation;
  relevantAppointment: RelevantAppointment | null;
}) {
  const contact = conversation.contact;
  const hasContactDetails = Boolean(contact?.company_name || contact?.phone || contact?.email);

  return (
    <div className="space-y-6">
      {contact ? (
        <div className={cardClass}>
          <div className={cardHeaderClass}>
            <h2 className={cardTitleClass}>Contact</h2>
            <Link href={`/contacts/${contact.id}`} className="text-sm font-medium text-slate-600 hover:text-slate-900">
              View
            </Link>
          </div>
          <div className="space-y-3 px-5 py-5">
            {hasContactDetails ? (
              <>
                {contact.company_name ? (
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Company</p>
                    <p className="mt-0.5 text-sm text-slate-900">{contact.company_name}</p>
                  </div>
                ) : null}
                {contact.phone ? (
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Phone</p>
                    <p className="mt-0.5 text-sm text-slate-900">{contact.phone}</p>
                  </div>
                ) : null}
                {contact.email ? (
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Email</p>
                    <p className="mt-0.5 text-sm text-slate-900">{contact.email}</p>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="text-sm text-slate-500">No contact details provided yet.</p>
            )}
          </div>
        </div>
      ) : null}

      {conversation.lead ? (
        <div className={cardClass}>
          <div className={cardHeaderClass}>
            <h2 className={cardTitleClass}>Lead</h2>
            <Link
              href={`/leads/${conversation.lead.id}`}
              className="text-sm font-medium text-slate-600 hover:text-slate-900"
            >
              View
            </Link>
          </div>
          <div className="space-y-3 px-5 py-5">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Service</p>
              <p className="mt-0.5 text-sm text-slate-900">{conversation.lead.service || "—"}</p>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Status</p>
              <p className="mt-0.5 text-sm text-slate-900">{LEAD_STATUS_LABELS[conversation.lead.status]}</p>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Temperature</p>
              <p className="mt-0.5 text-sm text-slate-900">{TEMPERATURE_LABELS[conversation.lead.temperature]}</p>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Estimated value</p>
              <p className="mt-0.5 text-sm text-slate-900">
                {conversation.lead.estimated_value != null
                  ? formatCurrency(conversation.lead.estimated_value)
                  : "—"}
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {relevantAppointment ? (
        <div className={cardClass}>
          <div className={cardHeaderClass}>
            <h2 className={cardTitleClass}>Appointment</h2>
            <Link
              href={`/appointments/${relevantAppointment.id}`}
              className="text-sm font-medium text-slate-600 hover:text-slate-900"
            >
              View
            </Link>
          </div>
          <div className="px-5 py-5">
            <p className="text-sm font-medium text-slate-900">{relevantAppointment.title}</p>
            <p className="mt-0.5 text-sm text-slate-500">
              {formatAppointmentDate(relevantAppointment.start_at)} ·{" "}
              {formatAppointmentTime(relevantAppointment.start_at)}
            </p>
            <p className="mt-1 text-xs text-slate-400">
              {APPOINTMENT_STATUS_LABELS[relevantAppointment.status]}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
