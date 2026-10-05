import { CalendarDays, Inbox, LayoutDashboard, Receipt, Target, Users, Wallet, Workflow, BarChart3, ArrowRight } from "lucide-react";

/**
 * A faithful, static rendering of Trackpr's Today screen in Trackpr's own
 * design language (warm gray workspace, white cards, dark pine sidebar,
 * one dark attention panel). Every label is the product's real wording
 * (Today's KPI row, Where the work stands, Needs your attention and its
 * registry labels). The figures are sample data and the frame says so -
 * nothing here is a customer result.
 */

const NAV = [
  { icon: LayoutDashboard, label: "Today", active: true },
  { icon: Users, label: "Contacts" },
  { icon: Target, label: "Leads" },
  { icon: Inbox, label: "Inbox" },
  { icon: Wallet, label: "Overview" },
  { icon: Receipt, label: "Invoices" },
  { icon: CalendarDays, label: "Calendar" },
  { icon: BarChart3, label: "Analytics" },
  { icon: Workflow, label: "Automations" },
];

const KPIS = [
  { label: "New leads", value: "4", detail: "Came in today" },
  { label: "Appointments", value: "3", detail: "On the calendar today" },
  { label: "Waiting on your reply", value: "2", detail: "2 conversations", attention: true },
  { label: "Unpaid", value: "$3,240", detail: "$1,180 past due · 2 invoices", attention: true },
];

const STAGES = [
  { label: "Leads", value: "$18,400", detail: "5 hot" },
  { label: "Quoted", value: "$12,600", detail: "4 estimates" },
  { label: "Accepted", value: "$4,850", detail: "2 to book" },
  { label: "In progress", value: "$7,300", detail: "3 jobs" },
  { label: "Ready to invoice", value: "$1,920", detail: "1 completed job" },
];

const ATTENTION = [
  { who: "Sample customer A", what: "Waiting on a reply", tone: "urgent", why: "Asked about availability this week.", action: "Open conversation", money: null },
  { who: "Sample customer B", what: "Estimate sent, awaiting reply", tone: "soon", why: "Sent 3 days ago. No response yet.", action: "View estimate", money: "$6,400" },
  { who: "Sample customer C", what: "Completed, not invoiced", tone: "soon", why: "Job finished yesterday.", action: "Create invoice", money: "$1,920" },
];

export function TrackprShowcase() {
  return (
    <figure className="overflow-hidden rounded-[20px] bg-canvas shadow-[0_0_0_1px_rgba(13,21,18,0.08),0_2px_4px_rgba(13,21,18,0.04),0_50px_100px_-50px_rgba(13,21,18,0.45)]">
      {/* The window's title bar - names the product and says plainly that the figures are samples. */}
      <figcaption className="flex items-center justify-between gap-3 border-b border-black/[0.06] bg-[#f7f6f3] px-4 py-2.5 sm:px-5">
        <span className="flex items-center gap-2">
          <span aria-hidden className="flex gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-black/[0.09]" />
            <span className="h-2.5 w-2.5 rounded-full bg-black/[0.09]" />
            <span className="h-2.5 w-2.5 rounded-full bg-black/[0.09]" />
          </span>
          <span className="ml-2 whitespace-nowrap text-[12px] font-medium text-ink-2">
            Trackpr <span className="hidden font-normal text-ink-3 sm:inline">· Today</span>
          </span>
        </span>
        <span className="whitespace-nowrap font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-3">
          <span className="hidden sm:inline">Illustrative · </span>sample data
        </span>
      </figcaption>
      <div className="flex">
        {/* Sidebar - md and up. */}
        <div aria-hidden className="hidden w-[188px] shrink-0 flex-col bg-sidebar md:flex">
          <div className="flex h-14 items-center gap-2.5 border-b border-dark-line px-4">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-[13px] font-bold text-white inset-ring inset-ring-black/10">T</span>
            <span className="leading-tight">
              <span className="block text-[13px] font-semibold text-on-dark">Trackpr</span>
              <span className="block text-[10.5px] text-on-dark-3">Your business</span>
            </span>
          </div>
          <ul className="space-y-0.5 px-2 py-3">
            {NAV.map((item) => (
              <li key={item.label} className={`flex h-7 items-center gap-2.5 rounded-md px-2.5 text-[12px] font-medium ${item.active ? "bg-dark-fill-strong text-on-dark inset-ring inset-ring-dark-line" : "text-on-dark-2"}`}>
                <item.icon className={`h-3.5 w-3.5 ${item.active ? "text-accent-on-dark" : "text-on-dark-3"}`} strokeWidth={1.75} />
                {item.label}
              </li>
            ))}
          </ul>
        </div>

        {/* Workspace. */}
        <div aria-hidden className="min-w-0 flex-1 p-4 sm:p-6">
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">Today</p>
              <p className="mt-1 text-lg font-semibold tracking-[-0.02em] text-ink sm:text-[22px]">Good morning</p>
              <p className="mt-0.5 text-[11.5px] text-ink-3">5 things need your attention today.</p>
            </div>
            <span className="hidden rounded-lg bg-accent px-3 py-1.5 text-[11px] font-medium text-white sm:inline">+ Add Lead</span>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2.5 xl:grid-cols-4">
            {KPIS.map((kpi) => (
              <div key={kpi.label} className="rounded-xl border border-line bg-surface p-3 shadow-card sm:p-3.5">
                <p className="truncate text-[10.5px] font-medium text-ink-3">{kpi.label}</p>
                <p className="mt-1.5 text-[20px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-ink sm:text-[22px]">{kpi.value}</p>
                <p className={`mt-1.5 truncate text-[10px] ${kpi.attention ? "font-medium text-warning-text" : "text-ink-3"}`}>{kpi.detail}</p>
              </div>
            ))}
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_260px]">
            <div className="hidden rounded-xl border border-line bg-surface p-3.5 shadow-card sm:block">
              <div className="flex items-center justify-between">
                <p className="text-[12.5px] font-semibold text-ink">Where the work stands</p>
                <span className="flex items-center gap-1 text-[10.5px] font-medium text-accent">
                  Open Money <ArrowRight className="h-3 w-3" />
                </span>
              </div>
              <div className="mt-2.5 grid grid-cols-5 gap-1.5">
                {STAGES.map((stage) => (
                  <div key={stage.label} className="rounded-lg bg-inset px-2 py-2 inset-ring inset-ring-line/70">
                    <p className="truncate text-[9.5px] font-medium text-ink-3">{stage.label}</p>
                    <p className="mt-0.5 text-[12.5px] font-semibold tabular-nums tracking-[-0.02em] text-ink">{stage.value}</p>
                    <p className="truncate text-[9.5px] text-ink-3">{stage.detail}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-xl bg-panel-dark p-3 text-on-dark lg:row-span-2">
              <div className="flex items-center justify-between px-1">
                <p className="text-[12.5px] font-semibold">Needs your attention</p>
                <span className="rounded-full bg-dark-fill-strong px-1.5 font-mono text-[10px] inset-ring inset-ring-dark-line">5</span>
              </div>
              <ul className="mt-2.5 space-y-1.5">
                {ATTENTION.map((row) => (
                  <li key={row.who} className="rounded-lg bg-dark-fill px-2.5 py-2 inset-ring inset-ring-dark-line">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="truncate text-[11.5px] font-semibold">{row.who}</p>
                      {row.money ? <p className="text-[11px] font-semibold tabular-nums">{row.money}</p> : null}
                    </div>
                    <p className={`mt-0.5 flex items-center gap-1 text-[10px] font-medium ${row.tone === "urgent" ? "text-danger-on-dark" : "text-warning-on-dark"}`}>
                      <span className={`h-1 w-1 rounded-full ${row.tone === "urgent" ? "bg-danger" : "bg-warning"}`} />
                      {row.what}
                    </p>
                    <p className="mt-0.5 truncate text-[10.5px] text-on-dark-2">{row.why}</p>
                    <p className="mt-1.5 text-[10.5px] font-medium text-accent-on-dark">{row.action} →</p>
                  </li>
                ))}
              </ul>
            </div>

            <div className="hidden rounded-xl border border-line bg-surface p-3.5 shadow-card sm:block">
              <p className="text-[12.5px] font-semibold text-ink">Opportunities</p>
              <div className="mt-2 divide-y divide-line">
                {[
                  ["Dormant customer", "Last job 5 months ago. Reach out to reconnect."],
                  ["Review request needed", "Job completed 3 days ago. Ask for a review."],
                ].map(([label, line]) => (
                  <div key={label} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="flex items-center gap-1 text-[10.5px] font-medium text-accent-text">
                        <span className="h-1 w-1 rounded-full bg-accent" />
                        {label}
                      </p>
                      <p className="truncate text-[11px] text-ink-2">{line}</p>
                    </div>
                    <span className="shrink-0 rounded-md border border-line-strong px-2 py-1 text-[10px] font-medium text-ink">View</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </figure>
  );
}
