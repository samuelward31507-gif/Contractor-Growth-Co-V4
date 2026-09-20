import { CalendarCheck2, CalendarClock, CheckCircle2, UserX } from "lucide-react";
import { sectionLabelClass } from "@/lib/ui/typography";
import { StatCard, StatGrid } from "@/lib/ui/stat-card";
import type { AppointmentSummary } from "@/lib/appointments/queries";

/**
 * This is the page's PRIMARY overview - "how's my day/week of appointments
 * shaping up" - so it gets the StatCard treatment (lib/ui/stat-card.tsx)
 * rather than the compact inline strip: 4 clean counts deserve room on a
 * wide desktop viewport the same way pipeline/estimate KPIs do elsewhere.
 * "Today" gets the one accent (success) icon in this row, and only when
 * there's actually something on the calendar today - a genuine "your day is
 * populated" signal, not decoration.
 */
export function AppointmentsSummary({ summary }: { summary: AppointmentSummary }) {
  return (
    <div>
      <p className={sectionLabelClass}>Overview</p>
      <div className="mt-3">
        <StatGrid columns={4}>
          <StatCard label="Upcoming" value={summary.upcoming} tone="info" icon={CalendarClock} />
          <StatCard
            label="Today"
            value={summary.today}
            tone={summary.today > 0 ? "success" : "neutral"}
            icon={CalendarCheck2}
          />
          <StatCard label="Completed" value={summary.completed} tone="neutral" icon={CheckCircle2} />
          <StatCard label="No-shows" value={summary.noShows} tone={summary.noShows > 0 ? "danger" : "neutral"} icon={UserX} />
        </StatGrid>
      </div>
    </div>
  );
}
