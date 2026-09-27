import Link from "next/link";

/**
 * Usability audit fix (#3, Dashboard executive hierarchy): a compact
 * "what's moving today" reference row, sitting below the primary
 * Attention/Pipeline region and above the detailed Today's Schedule list -
 * three real, already-computed numbers (never invented, never a new metric),
 * each linking to its real existing destination. Today's appointment count
 * reuses AppointmentSummary.today; estimates-awaiting reuses
 * OverviewMetrics.pendingEstimates (already a live COUNT(status='sent'), not
 * a range-scoped figure); active jobs reuses a live status count over the
 * same getJobs() read every other page already performs (see page.tsx's own
 * comment on activeJobsCount). No trend graph, no sparkline - three plain
 * numbers, matching the brief's own explicit "no decorative charts" rule.
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
    <div className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-xl border border-slate-200 bg-white px-5 py-4">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className="group flex items-baseline gap-2 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <span className="text-lg font-semibold tabular-nums text-slate-900 group-hover:underline">{item.value}</span>
          <span className="text-sm text-slate-500">{item.label}</span>
        </Link>
      ))}
    </div>
  );
}
