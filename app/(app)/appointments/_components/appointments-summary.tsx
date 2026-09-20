import { CalendarCheck2, CalendarClock, CheckCircle2, UserX } from "lucide-react";
import { sectionLabelClass } from "@/lib/ui/typography";
import { HeroStatRow, type HeroStatTone } from "@/lib/ui/hero-stat-row";
import type { AppointmentSummary } from "@/lib/appointments/queries";

/**
 * "Today" is what a contractor actually opens this page to check, so it
 * leads via lib/ui/hero-stat-row.tsx - success-toned only when there's
 * genuinely something on the calendar today, neutral otherwise (an empty
 * today is not a warning, just a fact).
 */
export function AppointmentsSummary({ summary }: { summary: AppointmentSummary }) {
  const heroTone: HeroStatTone = summary.today > 0 ? "success" : "neutral";

  return (
    <div>
      <p className={sectionLabelClass}>Overview</p>
      <div className="mt-3">
        <HeroStatRow
          hero={{ label: "Today", value: summary.today, icon: CalendarCheck2, tone: heroTone }}
          secondary={[
            { label: "Upcoming", value: summary.upcoming, icon: CalendarClock },
            { label: "Completed", value: summary.completed, icon: CheckCircle2 },
            { label: "No-shows", value: summary.noShows, icon: UserX },
          ]}
        />
      </div>
    </div>
  );
}
