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
import { primarySectionTitleClass, metaClass, numericDisplayClass } from "@/lib/ui/typography";
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

// Trackpr 2.0 full redesign: routed through the shared semantic tokens
// (globals.css) instead of raw Tailwind color literals - these move
// automatically if the palette is ever retuned again, and match the same
// muted register as Badge/HeroStatRow/every other status surface in the app.
const KIND_STYLE: Record<AttentionItem["kind"], string> = {
  overdue_appointment: "bg-warning-muted text-warning-text",
  hot_lead: "bg-danger-muted text-danger-text",
  high_value_lead: "bg-accent-muted text-accent-text",
  pending_estimate: "bg-info-muted text-info-text",
  calendar_disconnected: "bg-danger-muted text-danger-text",
  human_escalation: "bg-danger-muted text-danger-text",
  awaiting_reply: "bg-info-muted text-info-text",
  stale_estimate: "bg-warning-muted text-warning-text",
  dormant_customer: "bg-slate-100 text-slate-600",
  no_show: "bg-warning-muted text-warning-text",
  awaiting_confirmation: "bg-info-muted text-info-text",
  abandoned_conversation: "bg-slate-100 text-slate-600",
  accepted_estimate_no_job: "bg-accent-muted text-accent-text",
  uncontacted_lead: "bg-danger-muted text-danger-text",
  cancelled_appointment_no_rebooking: "bg-warning-muted text-warning-text",
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

function AttentionRow({ item }: { item: AttentionItem }) {
  const ItemIcon = KIND_ICON[item.kind];
  // HANDOFF-01: a human_escalation item is the one kind that's resolvable
  // in place - it gets the existing acknowledge/resolve controls (the same
  // ones already used on /automations) instead of a bare chevron, so the
  // contractor never has to leave the dashboard to act on it. The controls
  // sit as a sibling of the link, never nested inside it.
  const isEscalation = item.kind === "human_escalation" && item.incidentId;
  const isOpportunity = Boolean(item.opportunityId);
  const isUrgent = URGENT_KINDS.has(item.kind);
  return (
    <div
      className={`group -mx-2 flex items-center gap-3 border-l-2 py-3 pl-2.5 pr-2 transition-colors hover:bg-slate-50 ${
        isUrgent ? "border-l-danger/50" : "border-l-transparent"
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
        {item.value ? <span className={`shrink-0 text-sm font-semibold text-slate-700 ${numericDisplayClass}`}>{item.value}</span> : null}
        {!isEscalation && !isOpportunity ? (
          <ChevronRight className="h-4 w-4 shrink-0 text-slate-300 transition-colors group-hover:text-slate-500" aria-hidden />
        ) : null}
      </Link>
      {isEscalation ? <IncidentActions incidentId={item.incidentId!} status={item.incidentStatus ?? "open"} /> : null}
      {isOpportunity ? <DismissOpportunityButton opportunityId={item.opportunityId!} /> : null}
    </div>
  );
}

/**
 * The dashboard's one deliberately dominant section - the only place on the
 * page that gets a real heading (primarySectionTitleClass) rather than a
 * receding label, because "what needs me" is the most actionable question a
 * contractor asks when opening this page. Rows sit flush on the page canvas
 * with divider lines, not inside a bordered card; the empty state is the one
 * moment that earns a distinct surface, so it reads as a confirmed state
 * rather than a gap.
 *
 * Navigation/dashboard simplification pass: `previewCount` caps how many
 * items render up front (the page passes 3, matching the "a few things need
 * you" framing - never a hardcoded literal "3" in copy, since the real count
 * can be 0, 1, or many) - every remaining item is still fully present and
 * reachable, just tucked behind a native <details>/<summary> disclosure
 * rather than a second client component. Nothing is hidden permanently and
 * no item is dropped: this only changes how much renders open by default.
 */
export function AttentionPanel({ items, heading = "What needs you", previewCount }: { items: AttentionItem[]; heading?: string; previewCount?: number }) {
  const limit = previewCount ?? items.length;
  const visible = items.slice(0, limit);
  const rest = items.slice(limit);

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h2 className={primarySectionTitleClass}>{heading}</h2>
        {items.length > 0 ? <span className={metaClass}>{items.length}</span> : null}
      </div>

      {items.length === 0 ? (
        <div className={`${surfaceClass} mt-5 px-6 py-14 text-center`}>
          <p className="text-base font-medium text-slate-900">You&apos;re all caught up.</p>
          <p className="mt-1.5 text-sm text-slate-500">Nothing needs your attention right now.</p>
        </div>
      ) : (
        <div className="mt-3 divide-y divide-slate-100">
          {visible.map((item) => (
            <AttentionRow key={item.id} item={item} />
          ))}
          {rest.length > 0 ? (
            <details className="group/more">
              <summary className="-mx-2 cursor-pointer list-none rounded-md px-2.5 py-3 text-sm font-medium text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                {rest.length} more {rest.length === 1 ? "item" : "items"}
              </summary>
              <div className="divide-y divide-slate-100">
                {rest.map((item) => (
                  <AttentionRow key={item.id} item={item} />
                ))}
              </div>
            </details>
          ) : null}
        </div>
      )}
    </div>
  );
}
