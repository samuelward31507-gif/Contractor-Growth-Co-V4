import { Fragment } from "react";
import Link from "next/link";
import { numericDisplayClass } from "@/lib/ui/typography";

/**
 * Usability audit fix (#3, Dashboard executive hierarchy): a compact
 * "what's moving today" reference row, sitting below the primary
 * Attention/Pipeline region and above the detailed Today's Schedule list -
 * three real, already-computed numbers (never invented, never a new
 * metric), each linking to its real existing destination. Today's
 * appointment count reuses AppointmentSummary.today; estimates-awaiting
 * reuses OverviewMetrics.pendingEstimates (already a live
 * COUNT(status='sent'), not a range-scoped figure); active jobs reuses a
 * live status count over the same getJobs() read every other page already
 * performs (see page.tsx's own comment on activeJobsCount). No trend graph,
 * no sparkline - three plain numbers, matching the brief's own explicit
 * "no decorative charts" rule.
 *
 * Trackpr 2.0 full redesign: unboxed per the approved concept - three
 * numbers separated by hairline dividers, no bordered/filled container.
 */
export function OperationalStrip({
  todayCount,
  estimatesAwaitingCount,
  activeJobsCount,
}: {
  todayCount: number;
  estimatesAwaitingCount: number;
  activeJobsCount: number;
}) {
  const items: { href: string; value: number; label: string }[] = [
    { href: "/appointments?view=today", value: todayCount, label: todayCount === 1 ? "appointment today" : "appointments today" },
    { href: "/work?type=estimates&status=sent", value: estimatesAwaitingCount, label: "estimates awaiting" },
    { href: "/work?type=jobs", value: activeJobsCount, label: activeJobsCount === 1 ? "active job" : "active jobs" },
  ];

  return (
    <div className="flex flex-wrap items-center gap-x-10 gap-y-3">
      {items.map((item, index) => (
        <Fragment key={item.href}>
          {index > 0 ? <span className="hidden h-4 w-px bg-slate-200 sm:block" aria-hidden /> : null}
          <Link
            href={item.href}
            className="group flex items-baseline gap-2 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <span className={`text-lg font-semibold text-slate-900 group-hover:underline ${numericDisplayClass}`}>{item.value}</span>
            <span className="text-sm text-slate-500">{item.label}</span>
          </Link>
        </Fragment>
      ))}
    </div>
  );
}
