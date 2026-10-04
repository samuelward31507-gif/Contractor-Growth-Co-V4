import Link from "next/link";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ArrowRight, AlertCircle, Briefcase, CalendarClock, FileSearch, Phone, Receipt, ShieldOff, User, Wallet, Zap } from "lucide-react";
import { formatCurrency, formatRelativeTime } from "@/lib/dashboard/format";
import {
  formatAppointmentDate,
  formatAppointmentTime,
  STATUS_LABELS as APPOINTMENT_STATUS_LABELS,
} from "@/lib/appointments/format";
import { STATUS_LABELS as LEAD_STATUS_LABELS, TEMPERATURE_LABELS } from "@/lib/leads/format";
import { STATUS_LABELS as ESTIMATE_STATUS_LABELS } from "@/lib/estimates/format";
import { CONTACT_LIFECYCLE_LABEL, CONTACT_LIFECYCLE_TONE, type ContactLifecycleStage } from "@/lib/customers/lifecycle-stage";
import type { NextStep } from "@/lib/people/next-step";
import type { Estimate } from "@/lib/estimates/queries";
import type { Invoice } from "@/lib/invoices/queries";
import { formatInvoiceNumber, formatMoney, isOverdue } from "@/lib/invoices/domain";
import { INVOICE_STATUS_TONE, INVOICE_STATUS_ICON, INVOICE_STATUS_LABELS } from "@/app/(app)/invoices/_components/status";
import { detailLabelClass, detailValueClass } from "@/lib/ui/typography";
import { Badge } from "@/lib/ui/badge";
import { secondaryButtonAutoClass } from "@/lib/ui/form";
import type { Conversation, RelevantAppointment } from "@/lib/conversations/queries";

export type AutomationActivity = {
  aiEnabled: boolean;
  aiMessageCount: number;
  lastAiMessageAt: string | null;
};

export function ConversationContext({
  conversation,
  relevantAppointment,
  relevantEstimate,
  relevantInvoice,
  today,
  lifecycleStage,
  openLeadValueDisplay,
  nextStep,
  smsOptOut,
  automationActivity,
  timeZone,
}: {
  conversation: Conversation;
  relevantAppointment: RelevantAppointment | null;
  /** The most relevant real estimate for this contact (sent, else accepted, else most recent) - never a fabricated placeholder. Null when this contact has no estimates at all. */
  relevantEstimate: Estimate | null;
  /** Phase 1B-4: this contact's most relevant live invoice (open balance first, else most recent) - number, status, balance due and overdue only; never notes or ids. Null when there is none. */
  relevantInvoice: Invoice | null;
  /** Today's calendar date in the organization's timezone - what "overdue" is judged against. */
  today: string;
  /** Derived from this contact's own real leads/estimates/jobs/appointments/review-requests (deriveContactLifecycle) - null only when the conversation has no linked contact at all. */
  lifecycleStage: ContactLifecycleStage | null;
  /** Pre-formatted via formatOpenLeadValueDisplay, already excluding won/lost leads - null when there is no open opportunity for this contact. */
  openLeadValueDisplay: string | null;
  /** The same real next-step computation the Person page uses (findPersonNextStep), scoped to this contact - null when there's nothing outstanding. */
  nextStep: NextStep | null;
  smsOptOut: boolean;
  automationActivity: AutomationActivity;
  /** Trackpr 2.0, Launch Certification QA fix: the organization's real IANA timezone - without it, formatAppointmentDate/formatAppointmentTime below silently fall back to the server runtime's default (UTC). */
  timeZone: string | undefined;
}) {
  const contact = conversation.contact;
  const hasContactDetails = Boolean(contact?.company_name || contact?.phone || contact?.email);

  return (
    <div className="space-y-4 p-4 sm:p-6 xl:p-5">
      {contact ? (
        <div className="flex flex-wrap items-center gap-2">
          {contact.phone ? (
            <a href={`tel:${contact.phone}`} className={`${secondaryButtonAutoClass} gap-1.5`}>
              <Phone className="h-4 w-4" aria-hidden />
              Call
            </a>
          ) : null}
          <Link href={`/estimates?new=estimate&contactId=${contact.id}`} className={`${secondaryButtonAutoClass} gap-1.5`}>
            <FileSearch className="h-4 w-4" aria-hidden />
            Create Estimate
          </Link>
        </div>
      ) : null}

      {nextStep ? (
        <div className={`rounded-lg px-3.5 py-3 inset-ring  ${nextStep.attention ? "bg-warning-muted inset-ring-warning-border" : "bg-accent-muted/60 ring-accent-border/70"}`}>
          <div className="flex items-start gap-2.5">
            <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${nextStep.attention ? "bg-warning-muted text-warning-text" : "bg-accent-muted text-accent-text"}`}>
              {nextStep.attention ? <AlertCircle className="h-3.5 w-3.5" aria-hidden /> : <ArrowRight className="h-3.5 w-3.5" aria-hidden />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-ink-3">What happens next</p>
              <p className="text-sm font-semibold text-ink">{nextStep.label}</p>
              {nextStep.detail ? <p className="text-xs text-ink-3">{nextStep.detail}</p> : null}
              <Link href={nextStep.href} className="mt-1 inline-block text-xs font-medium text-accent hover:underline">
                View
              </Link>
            </div>
          </div>
        </div>
      ) : null}

      {contact ? (
        <ContextSection
          title="Contact"
          icon={User}
          action={
            <Link href={`/people/${contact.id}`} className="inline-flex min-h-11 items-center text-xs font-medium text-ink-2 hover:text-ink sm:min-h-0">
              View
            </Link>
          }
        >
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {lifecycleStage ? <Badge tone={CONTACT_LIFECYCLE_TONE[lifecycleStage]}>{CONTACT_LIFECYCLE_LABEL[lifecycleStage]}</Badge> : null}
            {smsOptOut ? (
              <Badge tone="warning" icon={ShieldOff}>
                Opted out of SMS
              </Badge>
            ) : null}
          </div>
          {openLeadValueDisplay ? (
            <div className="mb-3 flex items-center gap-1.5 text-sm text-ink-2">
              <Wallet className="h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden />
              <span className="font-medium tabular-nums">{openLeadValueDisplay}</span>
              <span className="text-ink-3">open opportunity</span>
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
            <p className="text-sm text-ink-3">No contact details provided yet.</p>
          )}
        </ContextSection>
      ) : null}

      {conversation.lead ? (
        <ContextSection
          title="Lead"
          icon={Briefcase}
          action={
            <Link
              href={`/leads/${conversation.lead.id}`}
              className="inline-flex min-h-11 items-center text-xs font-medium text-ink-2 hover:text-ink sm:min-h-0"
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
              <dd className={`${detailValueClass} tabular-nums`}>
                {conversation.lead.estimated_value != null ? formatCurrency(conversation.lead.estimated_value) : "—"}
              </dd>
            </div>
          </dl>
        </ContextSection>
      ) : null}

      {relevantAppointment ? (
        <ContextSection
          title="Appointment"
          icon={CalendarClock}
          action={
            <Link
              href={`/appointments/${relevantAppointment.id}`}
              className="inline-flex min-h-11 items-center text-xs font-medium text-ink-2 hover:text-ink sm:min-h-0"
            >
              View
            </Link>
          }
        >
          <p className="text-sm font-medium text-ink">{relevantAppointment.title}</p>
          <p className="mt-0.5 text-sm text-ink-3">
            {formatAppointmentDate(relevantAppointment.start_at, timeZone)} · {formatAppointmentTime(relevantAppointment.start_at, timeZone)}
          </p>
          <p className="mt-1 text-xs text-ink-3">{APPOINTMENT_STATUS_LABELS[relevantAppointment.status]}</p>
        </ContextSection>
      ) : null}

      {relevantInvoice ? (
        <ContextSection
          title="Invoice"
          icon={Receipt}
          action={
            <Link href={`/invoices/${relevantInvoice.id}`} className="inline-flex min-h-11 items-center text-xs font-medium text-ink-2 hover:text-ink sm:min-h-0">
              View
            </Link>
          }
        >
          <p className="text-sm font-medium text-ink">
            <span className="font-mono text-[12.5px] tabular-nums text-ink-3">{formatInvoiceNumber(relevantInvoice.number)}</span> · {relevantInvoice.title}
          </p>
          <p className="mt-0.5 text-sm font-medium tabular-nums text-ink-2">
            {relevantInvoice.status === "paid" ? `${formatMoney(relevantInvoice.total)} paid` : `${formatMoney(relevantInvoice.balance_due)} due`}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge tone={INVOICE_STATUS_TONE[relevantInvoice.status]} icon={INVOICE_STATUS_ICON[relevantInvoice.status]}>
              {INVOICE_STATUS_LABELS[relevantInvoice.status]}
            </Badge>
            {isOverdue({ status: relevantInvoice.status, dueDate: relevantInvoice.due_date }, today) ? <Badge tone="danger">Overdue</Badge> : null}
          </div>
        </ContextSection>
      ) : null}

      {relevantEstimate ? (
        <ContextSection
          title="Estimate"
          icon={FileSearch}
          action={
            <Link href={`/estimates/${relevantEstimate.id}`} className="inline-flex min-h-11 items-center text-xs font-medium text-ink-2 hover:text-ink sm:min-h-0">
              View
            </Link>
          }
        >
          <p className="text-sm font-medium text-ink">{relevantEstimate.title}</p>
          <p className="mt-0.5 text-sm font-medium tabular-nums text-ink-2">{relevantEstimate.amount != null ? formatCurrency(relevantEstimate.amount) : "—"}</p>
          <p className="mt-1 text-xs text-ink-3">{ESTIMATE_STATUS_LABELS[relevantEstimate.status]}</p>
        </ContextSection>
      ) : null}

      <ContextSection title="Automation activity" icon={Zap}>
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
      </ContextSection>
    </div>
  );
}

/**
 * Final redesign: one section of the context rail - a quiet heading row
 * (icon, title, its "View" link) above its content, separated from the
 * section before it by a hairline. Same title/icon/action/children as the
 * SectionCard it replaces here, so the rail reads as one integrated column
 * beside the conversation instead of a stack of floating cards.
 */
function ContextSection({ title, icon: Icon, action, children }: { title: string; icon?: LucideIcon; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-line pt-4">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold text-ink-2">
          {Icon ? <Icon className="h-3.5 w-3.5 text-ink-3" strokeWidth={1.75} aria-hidden /> : null}
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}
