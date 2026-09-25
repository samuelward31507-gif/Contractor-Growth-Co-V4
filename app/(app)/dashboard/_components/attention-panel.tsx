import Link from "next/link";
import { Clock, Flame, FileText, CalendarOff, MessageSquareWarning, DollarSign, MessageCircle, ChevronRight, type LucideIcon } from "lucide-react";
import { surfaceClass } from "@/lib/ui/surface";
import { primarySectionTitleClass, metaClass } from "@/lib/ui/typography";
import { IncidentActions } from "@/app/(app)/automations/_components/incident-actions";
import type { AttentionItem } from "@/lib/dashboard/queries";

const KIND_ICON: Record<AttentionItem["kind"], LucideIcon> = {
  overdue_appointment: Clock,
  hot_lead: Flame,
  high_value_lead: DollarSign,
  pending_estimate: FileText,
  calendar_disconnected: CalendarOff,
  human_escalation: MessageSquareWarning,
  awaiting_reply: MessageCircle,
};

const KIND_STYLE: Record<AttentionItem["kind"], string> = {
  overdue_appointment: "bg-amber-50 text-amber-600",
  hot_lead: "bg-red-50 text-red-600",
  high_value_lead: "bg-emerald-50 text-emerald-600",
  pending_estimate: "bg-blue-50 text-blue-600",
  calendar_disconnected: "bg-red-50 text-red-600",
  human_escalation: "bg-red-50 text-red-600",
  awaiting_reply: "bg-blue-50 text-blue-600",
};

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
            return (
              <div
                key={item.id}
                className="group -mx-2 flex items-center gap-3 rounded-md px-2 py-3 transition-colors hover:bg-slate-50"
              >
                <Link href={item.href} className="flex min-w-0 flex-1 items-center gap-3">
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${KIND_STYLE[item.kind]}`}>
                    <ItemIcon className="h-3.5 w-3.5" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-900">{item.title}</span>
                    <span className="block truncate text-xs text-slate-500">{item.detail}</span>
                  </span>
                  {item.value ? (
                    <span className="shrink-0 text-sm font-medium tabular-nums text-slate-700">{item.value}</span>
                  ) : null}
                  {!isEscalation ? (
                    <ChevronRight className="h-4 w-4 shrink-0 text-slate-300 transition-colors group-hover:text-slate-500" aria-hidden />
                  ) : null}
                </Link>
                {isEscalation ? <IncidentActions incidentId={item.incidentId!} status={item.incidentStatus ?? "open"} /> : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
