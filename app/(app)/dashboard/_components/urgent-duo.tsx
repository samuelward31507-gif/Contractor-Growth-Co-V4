import Link from "next/link";
import { Flame, CalendarCheck2, type LucideIcon } from "lucide-react";

/**
 * The two numbers a contractor actually opens the dashboard to check -
 * how many hot leads need a call today, and what's on the calendar today -
 * given real visual weight instead of sitting inside a six-card StatGrid
 * indistinguishable from every other number. Both counts come from the same
 * summarizeLeads/summarizeAppointments functions the Leads and Appointments
 * pages themselves already use (see dashboard/page.tsx) - not a new
 * computation, just the two figures a contractor would otherwise have to
 * open two other pages to find.
 */
function UrgentCard({
  href,
  icon: Icon,
  label,
  value,
  detail,
  tone,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  value: number;
  detail: string;
  tone: "danger" | "success" | "neutral";
}) {
  const TONE_CLASS = {
    danger: { border: "border-red-100 hover:border-red-200", iconBg: "bg-red-100 text-red-600", value: "text-red-700" },
    success: { border: "border-emerald-100 hover:border-emerald-200", iconBg: "bg-emerald-100 text-emerald-600", value: "text-emerald-700" },
    neutral: { border: "border-slate-200 hover:border-slate-300", iconBg: "bg-slate-100 text-slate-500", value: "text-slate-900" },
  }[tone];

  return (
    <Link
      href={href}
      className={`group flex items-center gap-4 rounded-2xl border bg-white p-5 transition-colors ${TONE_CLASS.border}`}
    >
      <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full ${TONE_CLASS.iconBg}`}>
        <Icon className="h-6 w-6" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className={`text-3xl font-bold tabular-nums ${TONE_CLASS.value}`}>{value}</p>
        <p className="mt-0.5 truncate text-sm font-semibold text-slate-900">{label}</p>
        <p className="truncate text-xs text-slate-500">{detail}</p>
      </div>
    </Link>
  );
}

export function UrgentDuo({ hotLeadCount, todayAppointmentCount }: { hotLeadCount: number; todayAppointmentCount: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <UrgentCard
        href="/leads?temperature=hot"
        icon={Flame}
        label="Hot leads"
        value={hotLeadCount}
        detail={hotLeadCount > 0 ? "Needs attention" : "None right now"}
        tone={hotLeadCount > 0 ? "danger" : "neutral"}
      />
      <UrgentCard
        href="/appointments?view=today"
        icon={CalendarCheck2}
        label="Today's appointments"
        value={todayAppointmentCount}
        detail={todayAppointmentCount > 0 ? "Upcoming schedule" : "Nothing scheduled today"}
        tone={todayAppointmentCount > 0 ? "success" : "neutral"}
      />
    </div>
  );
}
