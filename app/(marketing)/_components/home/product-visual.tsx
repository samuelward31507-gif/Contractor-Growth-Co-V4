import {
  LayoutDashboard,
  Users2,
  CalendarClock,
  FileText,
  Briefcase,
  Workflow,
  BarChart3,
  Inbox,
  PhoneCall,
  ListChecks,
  CalendarCheck2,
  FileCheck2,
  Trophy,
  type LucideIcon,
} from "lucide-react";
import { Section, SectionHeading } from "../section";

/**
 * No product screenshot exists in this repository, and the scope rules for
 * this build explicitly forbid fabricating one (a fake dashboard with
 * invented numbers, customer names, or conversion rates). This is a
 * deliberately illustrative "command center" mockup instead: real module
 * names and the real pipeline-stage sequence from Trackpr's authenticated
 * app (see app/(app)/dashboard/_components/pipeline-rail.tsx - same six
 * stages, same icons, same connected-node construction), with no invented
 * counts or activity. Colors match Trackpr's actual shipped shell exactly
 * (`#0a120f`, the same near-black as its sidebar) rather than an
 * approximate dark tone, so this reads as the real product, not a
 * generic dashboard sketch.
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

// The exact six stages and icons app/(app)/dashboard/_components/pipeline-rail.tsx
// uses for the real dashboard - "populated" here is illustrative (a couple of
// early stages lit up, the rest idle), never a specific invented count.
const PIPELINE_STAGES: { key: string; label: string; icon: LucideIcon; populated: boolean }[] = [
  { key: "new", label: "New", icon: Inbox, populated: true },
  { key: "contacted", label: "Contacted", icon: PhoneCall, populated: true },
  { key: "qualified", label: "Qualified", icon: ListChecks, populated: false },
  { key: "appointment", label: "Appointment", icon: CalendarCheck2, populated: false },
  { key: "estimate", label: "Estimate", icon: FileCheck2, populated: false },
  { key: "won", label: "Won", icon: Trophy, populated: false },
];

export function ProductVisual() {
  return (
    <Section id="trackpr" tone="dark">
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
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#0a120f] shadow-2xl shadow-black/40">
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
                    item.active ? "bg-emerald-500/[0.14] text-white ring-1 ring-inset ring-emerald-500/25" : "text-slate-400"
                  }`}
                >
                  <item.icon className={`h-3.5 w-3.5 shrink-0 ${item.active ? "text-emerald-400" : ""}`} aria-hidden />
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

              {/* Same connected-node construction as the real dashboard's
                  PipelineRail - a line running through opaque-background
                  icon nodes, not a Kanban board of card columns. */}
              <div className="relative mt-5 flex items-start justify-between">
                <span aria-hidden className="absolute left-0 right-0 top-[15px] h-px bg-white/10" />
                {PIPELINE_STAGES.map((stage) => (
                  <div key={stage.key} className="relative flex flex-1 flex-col items-center gap-1.5 text-center">
                    <span
                      className={`relative z-10 flex h-[30px] w-[30px] items-center justify-center rounded-full border ${
                        stage.populated
                          ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-400"
                          : "border-white/10 bg-[#0a120f] text-slate-600"
                      }`}
                    >
                      <stage.icon className="h-3.5 w-3.5" aria-hidden />
                    </span>
                    <span className={`text-[9px] font-medium ${stage.populated ? "text-slate-300" : "text-slate-600"}`}>
                      {stage.label}
                    </span>
                  </div>
                ))}
              </div>

              <p className="mt-6 text-xs font-semibold uppercase tracking-wider text-slate-500">Recent activity</p>
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
