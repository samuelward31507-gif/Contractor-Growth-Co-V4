import Link from "next/link";
import { Briefcase, CalendarClock, ShieldOff, User, Zap } from "lucide-react";
import { formatCurrency, formatRelativeTime } from "@/lib/dashboard/format";
import {
  formatAppointmentDate,
  formatAppointmentTime,
  STATUS_LABELS as APPOINTMENT_STATUS_LABELS,
} from "@/lib/appointments/format";
import { STATUS_LABELS as LEAD_STATUS_LABELS, TEMPERATURE_LABELS } from "@/lib/leads/format";
import { detailLabelClass, detailValueClass } from "@/lib/ui/typography";
import { Badge } from "@/lib/ui/badge";
import { SectionCard } from "@/lib/ui/section-card";
import type { Conversation, RelevantAppointment } from "@/lib/conversations/queries";

export type AutomationActivity = {
  aiEnabled: boolean;
  aiMessageCount: number;
  lastAiMessageAt: string | null;
};

export function ConversationContext({
  conversation,
  relevantAppointment,
  smsOptOut,
  automationActivity,
  timeZone,
}: {
  conversation: Conversation;
  relevantAppointment: RelevantAppointment | null;
  smsOptOut: boolean;
  automationActivity: AutomationActivity;
  /** Trackpr 2.0, Launch Certification QA fix: the organization's real IANA timezone - without it, formatAppointmentDate/formatAppointmentTime below silently fall back to the server runtime's default (UTC). */
  timeZone: string | undefined;
}) {
  const contact = conversation.contact;
  const hasContactDetails = Boolean(contact?.company_name || contact?.phone || contact?.email);

  return (
    <div className="space-y-4 p-4 sm:p-6 xl:p-4">
      {contact ? (
        <SectionCard
          title="Contact"
          icon={User}
          action={
            <Link href={`/contacts/${contact.id}`} className="text-xs font-medium text-slate-600 hover:text-slate-900">
              View
            </Link>
          }
        >
          {smsOptOut ? (
            <div className="mb-3">
              <Badge tone="warning" icon={ShieldOff}>
                Opted out of SMS
              </Badge>
            </div>
          ) : null}
          {hasContactDetails ? (
            <dl className="space-y-3">
              {contact.company_name ? (
                <div>
                  <dt className={detailLabelClass}>Company</dt>
                  <dd className={detailValueClass}>{contact.company_name}</dd>
                </div>
              ) : null}
              {contact.phone ? (
                <div>
                  <dt className={detailLabelClass}>Phone</dt>
                  <dd className={detailValueClass}>{contact.phone}</dd>
                </div>
              ) : null}
              {contact.email ? (
                <div>
                  <dt className={detailLabelClass}>Email</dt>
                  <dd className={detailValueClass}>{contact.email}</dd>
                </div>
              ) : null}
            </dl>
          ) : (
            <p className="text-sm text-slate-500">No contact details provided yet.</p>
          )}
        </SectionCard>
      ) : null}

      {conversation.lead ? (
        <SectionCard
          title="Lead"
          icon={Briefcase}
          action={
            <Link
              href={`/leads/${conversation.lead.id}`}
              className="text-xs font-medium text-slate-600 hover:text-slate-900"
            >
              View
            </Link>
          }
        >
          <dl className="space-y-3">
            <div>
              <dt className={detailLabelClass}>Service</dt>
              <dd className={detailValueClass}>{conversation.lead.service || "—"}</dd>
            </div>
            <div>
              <dt className={detailLabelClass}>Status</dt>
              <dd className={detailValueClass}>{LEAD_STATUS_LABELS[conversation.lead.status]}</dd>
            </div>
            <div>
              <dt className={detailLabelClass}>Temperature</dt>
              <dd className={detailValueClass}>{TEMPERATURE_LABELS[conversation.lead.temperature]}</dd>
            </div>
            <div>
              <dt className={detailLabelClass}>Estimated value</dt>
              <dd className={detailValueClass}>
                {conversation.lead.estimated_value != null ? formatCurrency(conversation.lead.estimated_value) : "—"}
              </dd>
            </div>
          </dl>
        </SectionCard>
      ) : null}

      {relevantAppointment ? (
        <SectionCard
          title="Appointment"
          icon={CalendarClock}
          action={
            <Link
              href={`/appointments/${relevantAppointment.id}`}
              className="text-xs font-medium text-slate-600 hover:text-slate-900"
            >
              View
            </Link>
          }
        >
          <p className="text-sm font-medium text-slate-900">{relevantAppointment.title}</p>
          <p className="mt-0.5 text-sm text-slate-500">
            {formatAppointmentDate(relevantAppointment.start_at, timeZone)} · {formatAppointmentTime(relevantAppointment.start_at, timeZone)}
          </p>
          <p className="mt-1 text-xs text-slate-400">{APPOINTMENT_STATUS_LABELS[relevantAppointment.status]}</p>
        </SectionCard>
      ) : null}

      <SectionCard title="Automation activity" icon={Zap}>
        <dl className="space-y-3">
          <div>
            <dt className={detailLabelClass}>AI replies</dt>
            <dd className="mt-1">
              <Badge tone={automationActivity.aiEnabled ? "success" : "neutral"}>
                {automationActivity.aiEnabled ? "Enabled for this conversation" : "Disabled for this conversation"}
              </Badge>
            </dd>
          </div>
          <div>
            <dt className={detailLabelClass}>Automated replies sent</dt>
            <dd className={detailValueClass}>{automationActivity.aiMessageCount}</dd>
          </div>
          {automationActivity.lastAiMessageAt ? (
            <div>
              <dt className={detailLabelClass}>Last automated reply</dt>
              <dd className={detailValueClass}>{formatRelativeTime(automationActivity.lastAiMessageAt)}</dd>
            </div>
          ) : null}
        </dl>
      </SectionCard>
    </div>
  );
}
