import Link from "next/link";
import {
  Clock,
  Flame,
  FileText,
  CalendarOff,
  MessageSquareWarning,
  DollarSign,
  MessageCircle,
  MessageCircleOff,
  ChevronRight,
  FileClock,
  UserX,
  CalendarX,
  CalendarCheck,
  FileCheck2,
  PhoneMissed,
  Repeat,
  Star,
  Share2,
  type LucideIcon,
} from "lucide-react";
import { surfaceClass } from "@/lib/ui/surface";
import { primarySectionTitleClass, metaClass } from "@/lib/ui/typography";
import { IncidentActions } from "@/app/(app)/automations/_components/incident-actions";
import { DismissOpportunityButton } from "./dismiss-opportunity-button";
import type { AttentionItem } from "@/lib/dashboard/queries";

const KIND_ICON: Record<AttentionItem["kind"], LucideIcon> = {
  overdue_appointment: Clock,
  hot_lead: Flame,
  high_value_lead: DollarSign,
  pending_estimate: FileText,
  calendar_disconnected: CalendarOff,
  human_escalation: MessageSquareWarning,
  awaiting_reply: MessageCircle,
  stale_estimate: FileClock,
  dormant_customer: UserX,
  no_show: CalendarX,
  awaiting_confirmation: CalendarCheck,
  abandoned_conversation: MessageCircleOff,
  accepted_estimate_no_job: FileCheck2,
  uncontacted_lead: PhoneMissed,
  cancelled_appointment_no_rebooking: Repeat,
  completed_job_no_review_request: Star,
  completed_job_no_referral_request: Share2,
};

const KIND_STYLE: Record<AttentionItem["kind"], string> = {
  overdue_appointment: "bg-amber-50 text-amber-600",
  hot_lead: "bg-red-50 text-red-600",
  high_value_lead: "bg-emerald-50 text-emerald-600",
  pending_estimate: "bg-blue-50 text-blue-600",
  calendar_disconnected: "bg-red-50 text-red-600",
  human_escalation: "bg-red-50 text-red-600",
  awaiting_reply: "bg-blue-50 text-blue-600",
  stale_estimate: "bg-amber-50 text-amber-600",
  dormant_customer: "bg-slate-100 text-slate-600",
  no_show: "bg-amber-50 text-amber-600",
  awaiting_confirmation: "bg-blue-50 text-blue-600",
  abandoned_conversation: "bg-slate-100 text-slate-600",
  accepted_estimate_no_job: "bg-emerald-50 text-emerald-600",
  uncontacted_lead: "bg-red-50 text-red-600",
  cancelled_appointment_no_rebooking: "bg-amber-50 text-amber-600",
  completed_job_no_review_request: "bg-slate-100 text-slate-600",
  completed_job_no_referral_request: "bg-slate-100 text-slate-600",
};

/**
 * Trackpr 2.0, Phase 3B: a purely presentational "this needs action today"
 * grouping, derived from the exact same tier-1/tier-2 kinds
 * lib/dashboard/queries.ts's own documented priority ordering already puts
 * first (see that file's own 5-tier comment on the final attentionItems
 * array) - never a new field, never a numeric score, never a second
 * ordering. This only decides whether a row gets a small time-sensitive
 * accent mark; it has zero effect on which items appear or in what order -
 * that remains entirely the server's own, unchanged priority list.
 */
const URGENT_KINDS = new Set<AttentionItem["kind"]>([
  "human_escalation",
  "awaiting_reply",
  "abandoned_conversation",
  "calendar_disconnected",
  "overdue_appointment",
  "awaiting_confirmation",
  "no_show",
  "accepted_estimate_no_job",
]);

/**
 * The dashboard's one deliberately dominant section - the only place on the
 * page that gets a real heading (primarySectionTitleClass) rather than a
 * receding label, because "what needs me" is the most actionable question a
 * contractor asks when opening this page. Rows sit flush on the page canvas
 * with divider lines, not inside a bordered card; the empty state is the one
 * moment that earns a distinct surface, so it reads as a confirmed state
 * rather than a gap.
 */
export function AttentionPanel({ items }: { items: AttentionItem[] }) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h2 className={primarySectionTitleClass}>Needs your attention</h2>
        {items.length > 0 ? <span className={metaClass}>{items.length}</span> : null}
      </div>

      {items.length === 0 ? (
        <div className={`${surfaceClass} mt-5 px-6 py-14 text-center`}>
          <p className="text-base font-medium text-slate-900">You&apos;re all caught up.</p>
          <p className="mt-1.5 text-sm text-slate-500">Nothing needs your attention right now.</p>
        </div>
      ) : (
        <div className="mt-3 divide-y divide-slate-100">
          {items.map((item) => {
            const ItemIcon = KIND_ICON[item.kind];
            // HANDOFF-01: a human_escalation item is the one kind that's
            // resolvable in place - it gets the existing acknowledge/resolve
            // controls (the same ones already used on /automations) instead
            // of a bare chevron, so the contractor never has to leave the
            // dashboard to act on it. The controls sit as a sibling of the
            // link, never nested inside it.
            const isEscalation = item.kind === "human_escalation" && item.incidentId;
            const isOpportunity = Boolean(item.opportunityId);
            const isUrgent = URGENT_KINDS.has(item.kind);
            return (
              <div
                key={item.id}
                className={`group -mx-2 flex items-center gap-3 border-l-2 py-3 pl-2.5 pr-2 transition-colors hover:bg-slate-50 ${
                  isUrgent ? "border-l-red-300" : "border-l-transparent"
                }`}
              >
                <Link
                  href={item.href}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-1"
                >
                  <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${KIND_STYLE[item.kind]}`}>
                    <ItemIcon className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-slate-900">{item.title}</span>
                    <span className="block truncate text-xs text-slate-500">{item.detail}</span>
                  </span>
                  {item.value ? (
                    <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-700">{item.value}</span>
                  ) : null}
                  {!isEscalation && !isOpportunity ? (
                    <ChevronRight className="h-4 w-4 shrink-0 text-slate-300 transition-colors group-hover:text-slate-500" aria-hidden />
                  ) : null}
                </Link>
                {isEscalation ? <IncidentActions incidentId={item.incidentId!} status={item.incidentStatus ?? "open"} /> : null}
                {isOpportunity ? <DismissOpportunityButton opportunityId={item.opportunityId!} /> : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
