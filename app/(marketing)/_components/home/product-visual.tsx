import {
  LayoutDashboard,
  Users2,
  CalendarClock,
  FileText,
  Briefcase,
  Workflow,
  BarChart3,
  type LucideIcon,
} from "lucide-react";
import { Section, SectionHeading } from "../section";

/**
 * No product screenshot exists in this repository, and the scope rules for
 * this build explicitly forbid fabricating one (a fake dashboard with
 * invented numbers, customer names, or conversion rates). This is a
 * deliberately illustrative "command center" mockup instead: real module
 * names from Trackpr's authenticated app (see app/(app)/leads,
 * /appointments, /estimates, /jobs, /automation-health), with placeholder
 * bars standing in for content rather than any invented specifics.
 */
const NAV_ITEMS: { icon: LucideIcon; label: string; active?: boolean }[] = [
  { icon: LayoutDashboard, label: "Dashboard", active: true },
  { icon: Users2, label: "Leads" },
  { icon: CalendarClock, label: "Appointments" },
  { icon: FileText, label: "Estimates" },
  { icon: Briefcase, label: "Jobs" },
  { icon: Workflow, label: "Automations" },
  { icon: BarChart3, label: "Analytics" },
];

const PIPELINE = [
  { label: "New", cards: 3 },
  { label: "Qualified", cards: 4 },
  { label: "Booked", cards: 2 },
  { label: "Won", cards: 3 },
];

export function ProductVisual() {
  return (
    <Section tone="dark">
      <div className="grid grid-cols-1 items-center gap-14 lg:grid-cols-2">
        <div>
          <SectionHeading
            eyebrow="The operating system underneath"
            title="Your Business, Finally in One Place."
            description="Trackpr is the operating system behind your growth system — one place to manage leads, appointments, estimates, jobs, automations, and business activity."
            dark
          />
          <p className="mt-6 max-w-md text-sm leading-relaxed text-slate-400">
            Trackpr isn&apos;t sold to you as standalone software to configure yourself. It&apos;s the system we
            build, connect, and manage as part of your Contractor Growth Co. service.
          </p>
          <p className="mt-6 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Powered by Trackpr. Managed by Contractor Growth Co.
          </p>
        </div>

        {/* A conceptual product window - browser-style chrome, a real
            sidebar of module names, and a pipeline/activity layout built
            from placeholder bars rather than any invented content. */}
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-slate-900/60 shadow-2xl shadow-black/40">
          <div className="flex items-center gap-1.5 border-b border-white/10 bg-white/[0.02] px-4 py-3">
            <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
            <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
            <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
          </div>

          <div className="flex">
            <div className="hidden w-36 shrink-0 flex-col gap-1 border-r border-white/10 p-3 sm:flex">
              {NAV_ITEMS.map((item) => (
                <div
                  key={item.label}
                  className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium ${
                    item.active ? "bg-emerald-500/15 text-emerald-400" : "text-slate-400"
                  }`}
                >
                  <item.icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="truncate">{item.label}</span>
                </div>
              ))}
            </div>

            <div className="min-w-0 flex-1 p-5">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Pipeline</p>
                <span className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
                  Automations active
                </span>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {PIPELINE.map((stage) => (
                  <div key={stage.label} className="rounded-lg border border-white/10 bg-white/[0.02] p-2">
                    <p className="text-[10px] font-medium text-slate-500">{stage.label}</p>
                    <div className="mt-2 flex flex-col gap-1">
                      {Array.from({ length: stage.cards }).map((_, i) => (
                        <span key={i} className="h-2.5 rounded-sm bg-white/10" style={{ width: `${70 + (i % 3) * 10}%` }} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <p className="mt-5 text-xs font-semibold uppercase tracking-wider text-slate-500">Recent activity</p>
              <div className="mt-3 flex flex-col gap-2.5">
                {[1, 2, 3].map((row) => (
                  <div key={row} className="flex items-center gap-3">
                    <span className="h-6 w-6 shrink-0 rounded-full bg-white/10" />
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <span className="h-2 rounded-sm bg-white/10" style={{ width: `${55 - row * 5}%` }} />
                      <span className="h-2 rounded-sm bg-white/[0.06]" style={{ width: `${30 - row * 3}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}
