import Link from "next/link";
import { FileText, Wrench, Star, MessageSquareWarning } from "lucide-react";
import type { OwnerDailyBriefing, EndOfDaySummary } from "@/lib/briefing/queries";
import { sectionLabelClass, metaClass } from "@/lib/ui/typography";
import { Badge } from "@/lib/ui/badge";

/**
 * Growth System Completion Pass 2, Parts 5 & 6: the dashboard already shows
 * hot leads, today's appointments, and system status (see AttentionPanel/
 * TodaysSchedule/SystemStatus above this panel) - this panel deliberately
 * does NOT repeat any of that. It surfaces only what those existing panels
 * don't: estimates awaiting a reply, jobs completed recently, review/
 * referral opportunities waiting on the contractor's own follow-through, AI
 * conversations waiting on a human, plus the two deterministic one-line
 * summaries (never AI-generated - see lib/briefing/queries.ts).
 */
function EmptyRow({ label }: { label: string }) {
  return <p className="py-1.5 text-sm text-slate-400">{label}</p>;
}

export function BriefingPanel({ briefing, endOfDay }: { briefing: OwnerDailyBriefing; endOfDay: EndOfDaySummary }) {
  const hasNewSignals =
    briefing.estimatesAwaitingAction.length > 0 || briefing.jobsRecentlyCompleted.length > 0 || briefing.reviewReferralOpportunities.length > 0 || briefing.aiEscalationsCount > 0;

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
      <div>
        <p className={sectionLabelClass}>Today&apos;s briefing</p>
        <p className="mt-1.5 text-sm font-medium text-slate-900">{briefing.summary}</p>

        {hasNewSignals ? (
          <ul className="mt-3 divide-y divide-slate-100">
            {briefing.aiEscalationsCount > 0 ? (
              <li className="flex items-center justify-between gap-3 py-2">
                <span className="flex items-center gap-2 text-sm text-slate-700">
                  <MessageSquareWarning aria-hidden className="h-4 w-4 text-amber-600" />
                  Conversations waiting on you
                </span>
                <Link href="/conversations" className="text-sm font-semibold tabular-nums text-slate-900 hover:underline">
                  {briefing.aiEscalationsCount}
                </Link>
              </li>
            ) : null}
            {briefing.estimatesAwaitingAction.map((estimate) => (
              <li key={estimate.id} className="flex items-center justify-between gap-3 py-2">
                <span className="flex min-w-0 items-center gap-2 text-sm text-slate-700">
                  <FileText aria-hidden className="h-4 w-4 shrink-0 text-slate-400" />
                  <span className="truncate">{estimate.contactName ?? estimate.title}</span>
                </span>
                <Link href={estimate.href} className="shrink-0 text-xs font-medium text-slate-500 hover:text-slate-900">
                  {estimate.value ?? "View"}
                </Link>
              </li>
            ))}
            {briefing.jobsRecentlyCompleted.map((job) => (
              <li key={job.id} className="flex items-center justify-between gap-3 py-2">
                <span className="flex min-w-0 items-center gap-2 text-sm text-slate-700">
                  <Wrench aria-hidden className="h-4 w-4 shrink-0 text-slate-400" />
                  <span className="truncate">{job.contactName ?? job.title}</span>
                </span>
                <Link href={job.href} className="shrink-0 text-xs font-medium text-slate-500 hover:text-slate-900">
                  Completed
                </Link>
              </li>
            ))}
            {briefing.reviewReferralOpportunities.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-3 py-2">
                <span className="flex items-center gap-2 text-sm text-slate-700">
                  <Star aria-hidden className="h-4 w-4 shrink-0 text-slate-400" />
                  {item.kind === "review" ? "Review reply waiting" : "Referral reply waiting"}
                </span>
                <Link href={item.href} className="shrink-0 text-xs font-medium text-slate-500 hover:text-slate-900">
                  View
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyRow label="Nothing new beyond what's shown above." />
        )}
      </div>

      <div>
        <p className={sectionLabelClass}>Today&apos;s activity</p>
        <p className="mt-1.5 text-sm font-medium text-slate-900">{endOfDay.summary}</p>
        <div className="mt-3 divide-y divide-slate-100">
          <div className="flex items-center justify-between py-2 text-sm">
            <span className="text-slate-600">Leads received</span>
            <span className="font-semibold tabular-nums text-slate-900">{endOfDay.leadsReceived}</span>
          </div>
          <div className="flex items-center justify-between py-2 text-sm">
            <span className="text-slate-600">Appointments booked</span>
            <span className="font-semibold tabular-nums text-slate-900">{endOfDay.appointmentsBooked}</span>
          </div>
          <div className="flex items-center justify-between py-2 text-sm">
            <span className="text-slate-600">Estimates sent</span>
            <span className="font-semibold tabular-nums text-slate-900">{endOfDay.estimatesSent}</span>
          </div>
          <div className="flex items-center justify-between py-2 text-sm">
            <span className="text-slate-600">Jobs won / completed</span>
            <span className="font-semibold tabular-nums text-slate-900">{endOfDay.jobsWonOrCompleted}</span>
          </div>
          {endOfDay.automationIncidentsCount > 0 ? (
            <div className="flex items-center justify-between py-2 text-sm">
              <span className="text-slate-600">Automation incidents</span>
              <Badge tone="warning">{endOfDay.automationIncidentsCount}</Badge>
            </div>
          ) : null}
        </div>
        <p className={`mt-2 ${metaClass}`}>Quoted/contracted value represented, not collected payments.</p>
      </div>
    </div>
  );
}
