import {
  Users2,
  Contact,
  MessageSquare,
  CalendarClock,
  FileText,
  Briefcase,
  Star,
  BarChart3,
  HeartPulse,
  type LucideIcon,
} from "lucide-react";
import { Section, SectionHeading } from "../section";

/**
 * No product screenshot exists in this repository, and the scope rules for
 * this build explicitly forbid fabricating one (a fake dashboard with
 * invented numbers). This is a real, honest representation instead: the
 * actual modules Trackpr's authenticated app is built from (see
 * app/(app)/leads, /contacts, /conversations, /appointments, /estimates,
 * /jobs, /automation-health, /activity), shown as a system diagram rather
 * than a screenshot standing in for one.
 */
const MODULES: { icon: LucideIcon; label: string }[] = [
  { icon: Users2, label: "Leads" },
  { icon: Contact, label: "Contacts" },
  { icon: MessageSquare, label: "Conversations" },
  { icon: CalendarClock, label: "Appointments" },
  { icon: FileText, label: "Estimates" },
  { icon: Briefcase, label: "Jobs" },
  { icon: Star, label: "Reviews & Referrals" },
  { icon: BarChart3, label: "Analytics" },
  { icon: HeartPulse, label: "Automation Health" },
];

export function ProductVisual() {
  return (
    <Section tone="dark">
      <div className="grid grid-cols-1 items-center gap-14 lg:grid-cols-2">
        <div>
          <SectionHeading
            eyebrow="The operating system underneath"
            title="Your Business, Finally in One Place."
            description="Trackpr is the operating system behind your growth system — giving you one place to manage leads, customers, appointments, estimates, jobs, conversations, reviews, referrals, and business activity."
            dark
          />
          <p className="mt-6 max-w-md text-sm leading-relaxed text-slate-400">
            Trackpr isn&apos;t sold to you as standalone software to configure yourself. It&apos;s the system we
            build, connect, and manage as part of your Contractor Growth Co. service.
          </p>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
          <div className="grid grid-cols-3 gap-3">
            {MODULES.map((mod) => (
              <div
                key={mod.label}
                className="flex flex-col items-center justify-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-7 text-center"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
                  <mod.icon className="h-4 w-4" aria-hidden />
                </span>
                <p className="text-xs font-medium text-slate-200">{mod.label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}
