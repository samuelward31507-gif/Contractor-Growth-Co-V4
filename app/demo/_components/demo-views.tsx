"use client";

import { useState } from "react";
import { AlertTriangle, Plus, Search, FileText, Workflow, CheckCircle2, Star, TrendingUp } from "lucide-react";
import { formatCurrency } from "@/lib/dashboard/format";
import { PageHeader } from "@/lib/ui/page-header";
import { Panel } from "@/lib/ui/section-card";
import { Badge } from "@/lib/ui/badge";
import { EmptyState } from "@/lib/ui/empty-state";
import { HeroStatRow } from "@/lib/ui/hero-stat-row";
import { inputClass, primaryButtonAutoClass } from "@/lib/ui/form";
import { pageTitleClass, pageDescriptionClass, sectionLabelClass, primarySectionTitleClass, metaClass } from "@/lib/ui/typography";
import { DemoMetricStrip, DemoRow, StageBadge, useDemoAction } from "./demo-shared";
import {
  DEMO_AUTOMATIONS,
  DEMO_AUTOMATION_METRICS,
  DEMO_BUSINESS_NAME,
  DEMO_CUSTOMERS,
  DEMO_DATE_LABEL,
  DEMO_ESTIMATES_JOBS,
  DEMO_ESTIMATE_METRICS,
  DEMO_GROWTH_METRICS,
  DEMO_NEXT_DAY_APPOINTMENTS,
  DEMO_NEXT_DAY_LABEL,
  DEMO_OPPORTUNITIES,
  DEMO_OPPORTUNITY_TOTAL,
  DEMO_PIPELINE_VALUE,
  DEMO_REVIEWS,
  DEMO_SUPPORTING_METRICS,
  DEMO_TODAY_APPOINTMENTS,
  DEMO_TOP_METRICS,
  type DemoAppointment,
} from "./demo-data";

const PAGE_CLASS = "flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10";
const CUSTOMER_ROW_GRID = "grid-cols-[minmax(0,1fr)_140px_130px_110px]";

function initials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function appointmentBadgeTone(status: DemoAppointment["status"]): "success" | "warning" | "neutral" {
  if (status === "Confirmed") return "success";
  if (status === "Pending") return "warning";
  return "neutral";
}

function ScheduleRow({ appointment }: { appointment: DemoAppointment }) {
  const isOpen = appointment.status === "Open";
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="flex min-w-0 items-center gap-4">
        <span className="w-[76px] shrink-0 text-xs font-medium tabular-nums text-ink-3">{appointment.time}</span>
        <span className="min-w-0 truncate text-sm text-ink-2">
          {isOpen ? (
            <span className="text-ink-3">Open slot</span>
          ) : (
            <>
              <span className="font-medium text-ink">{appointment.customer}</span> · {appointment.service}
            </>
          )}
        </span>
      </div>
      <Badge tone={appointmentBadgeTone(appointment.status)}>{appointment.status}</Badge>
    </div>
  );
}

/** The one heading on the page that should genuinely lead the eye - mirrors the real /dashboard's own single primarySectionTitleClass use (Needs your attention). */
function AttentionSection() {
  return (
    <div>
      <h2 className={primarySectionTitleClass}>Needs your attention</h2>
      <div className="mt-4 divide-y divide-line">
        {DEMO_OPPORTUNITIES.map((item) => (
          <div key={item.id} className="flex items-center gap-3 py-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-warning-muted text-warning">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium text-ink">
                  {item.category} <span className="text-ink-3">— {item.customer}</span>
                </span>
                <span className="shrink-0 text-sm font-semibold tabular-nums text-ink">{formatCurrency(item.value)}</span>
              </span>
              <span className="block truncate text-xs text-ink-3">{item.reason}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DemoDashboardView() {
  return (
    <div className={PAGE_CLASS}>
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className={sectionLabelClass}>Dashboard · {DEMO_DATE_LABEL}</p>
          <h1 className={`mt-1.5 ${pageTitleClass}`}>Good morning, {DEMO_BUSINESS_NAME}.</h1>
          <p className={`mt-1.5 ${pageDescriptionClass}`}>Here&rsquo;s what needs your attention today.</p>
        </div>
        <div className="rounded-lg border border-accent-border bg-accent-muted/60 px-5 py-4 sm:min-w-[240px]">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-accent-text/70">Pipeline value</p>
          <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums text-accent-text">{formatCurrency(DEMO_PIPELINE_VALUE)}</p>
        </div>
      </div>

      <DemoMetricStrip items={DEMO_TOP_METRICS} />

      <AttentionSection />

      <div className="border-t border-line pt-8">
        <p className={sectionLabelClass}>Today&rsquo;s schedule</p>
        <div className="mt-3 divide-y divide-line">
          {DEMO_TODAY_APPOINTMENTS.map((appointment) => (
            <ScheduleRow key={appointment.id} appointment={appointment} />
          ))}
        </div>
      </div>

      <div className="border-t border-line pt-8">
        <p className={sectionLabelClass}>Intelligence</p>
        <div className="mt-2 divide-y divide-line">
          {DEMO_SUPPORTING_METRICS.map((metric) => (
            <DemoRow key={metric.label} label={metric.label} value={metric.value} />
          ))}
        </div>
      </div>
    </div>
  );
}

export function DemoCustomersView() {
  const announce = useDemoAction();
  const [query, setQuery] = useState("");
  const term = query.trim().toLowerCase();
  const filtered = DEMO_CUSTOMERS.filter(
    (customer) => !term || customer.name.toLowerCase().includes(term) || customer.service.toLowerCase().includes(term),
  );

  return (
    <div className={PAGE_CLASS}>
      <PageHeader
        eyebrow="Operate"
        title="Customers"
        description={`Everyone ${DEMO_BUSINESS_NAME} is currently working with or has worked with.`}
        action={
          <button
            type="button"
            onClick={() => announce("This is a demo — in your real account this opens a form to add a new customer instantly.")}
            className={primaryButtonAutoClass}
          >
            <Plus className="h-4 w-4" aria-hidden />
            Add customer
          </button>
        }
      />

      <div>
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name or service…"
            aria-label="Search customers"
            className={`${inputClass} pl-9`}
          />
        </div>

        <div className="mt-4">
          {filtered.length === 0 ? (
            <EmptyState icon={Search} title={`No customers match "${query}"`} description="Try a different name or service." />
          ) : (
            <>
              <div className="hidden lg:block">
                <div className={`grid ${CUSTOMER_ROW_GRID} gap-6 border-b border-line px-2 pb-3`}>
                  <span className="text-xs text-ink-3">Customer</span>
                  <span className="text-xs text-ink-3">Service</span>
                  <span className="text-xs text-ink-3">Stage</span>
                  <span className="text-right text-xs text-ink-3">Value</span>
                </div>
                <div className="divide-y divide-line">
                  {filtered.map((customer) => (
                    <button
                      key={customer.id}
                      type="button"
                      onClick={() => announce(`This is a demo — in your real account this opens ${customer.name}'s full profile.`)}
                      className={`grid w-full ${CUSTOMER_ROW_GRID} items-center gap-6 rounded-md px-2 py-3.5 text-left transition-colors hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset`}
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-inset text-xs font-medium text-ink-2">
                          {initials(customer.name)}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-ink">{customer.name}</span>
                          <span className="block truncate text-xs text-ink-3">{customer.lastActivity}</span>
                        </span>
                      </span>
                      <span className="truncate text-sm text-ink-2">{customer.service}</span>
                      <span>
                        <StageBadge label={customer.stage} tone={customer.stageTone} />
                      </span>
                      <span className="text-right text-sm font-semibold tabular-nums text-ink">{formatCurrency(customer.value)}</span>
                    </button>
                  ))}
                </div>
              </div>

              <ul className="divide-y divide-line lg:hidden">
                {filtered.map((customer) => (
                  <li key={customer.id}>
                    <button
                      type="button"
                      onClick={() => announce(`This is a demo — in your real account this opens ${customer.name}'s full profile.`)}
                      className="flex w-full items-center gap-3 px-2 py-3.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-inset text-xs font-medium text-ink-2">
                        {initials(customer.name)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium text-ink">{customer.name}</span>
                          <StageBadge label={customer.stage} tone={customer.stageTone} />
                        </span>
                        <span className="mt-0.5 flex items-center justify-between gap-2">
                          <span className="truncate text-xs text-ink-3">{customer.service}</span>
                          <span className="shrink-0 text-xs font-semibold tabular-nums text-ink">{formatCurrency(customer.value)}</span>
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function DemoOpportunitiesView() {
  return (
    <div className={PAGE_CLASS}>
      <PageHeader
        eyebrow="Growth"
        title="Opportunities"
        description="Revenue opportunities identified from real customer activity - not guesses."
      />

      <DemoMetricStrip
        items={[
          { label: "Open opportunities", value: String(DEMO_OPPORTUNITIES.length) },
          { label: "Total identified value", value: formatCurrency(DEMO_OPPORTUNITY_TOTAL) },
        ]}
      />

      <div>
        <div className="divide-y divide-line">
          {DEMO_OPPORTUNITIES.map((item) => (
            <div key={item.id} className="flex items-center gap-3 py-3.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-warning-muted text-warning">
                <TrendingUp className="h-4 w-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-ink">{item.category}</span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-ink">{formatCurrency(item.value)}</span>
                </span>
                <span className="block truncate text-xs text-ink-3">
                  {item.customer} — {item.reason}
                </span>
              </span>
            </div>
          ))}
        </div>
        <p className={`mt-4 ${metaClass}`}>Identified automatically from real customer activity - never a fabricated lead.</p>
      </div>
    </div>
  );
}

export function DemoScheduleView() {
  return (
    <div className={PAGE_CLASS}>
      <PageHeader
        eyebrow="Operate"
        title="Schedule"
        description="Your real-time scheduling command center - appointments, availability, and blocked time in one place."
      />

      <div>
        <p className={sectionLabelClass}>Today · {DEMO_DATE_LABEL}</p>
        <div className="mt-3 divide-y divide-line">
          {DEMO_TODAY_APPOINTMENTS.map((appointment) => (
            <ScheduleRow key={appointment.id} appointment={appointment} />
          ))}
        </div>
      </div>

      <div className="border-t border-line pt-8">
        <p className={sectionLabelClass}>{DEMO_NEXT_DAY_LABEL}</p>
        <div className="mt-3 divide-y divide-line">
          {DEMO_NEXT_DAY_APPOINTMENTS.map((appointment) => (
            <ScheduleRow key={appointment.id} appointment={appointment} />
          ))}
        </div>
      </div>
    </div>
  );
}

export function DemoWorkView() {
  return (
    <div className={PAGE_CLASS}>
      <PageHeader eyebrow="Operate" title="Estimates & Jobs" description="Create, send, and track project estimates and jobs." />

      <HeroStatRow
        hero={{ label: "Open estimates", value: DEMO_ESTIMATE_METRICS[0].value, icon: FileText, tone: "info" }}
        secondary={DEMO_ESTIMATE_METRICS.slice(1).map((metric) => ({ label: metric.label, value: metric.value }))}
      />

      <div className="hidden lg:block">
        <div className="grid grid-cols-[minmax(0,1fr)_140px_130px_90px_110px] gap-6 border-b border-line px-2 pb-3">
          <span className="text-xs text-ink-3">Customer</span>
          <span className="text-xs text-ink-3">Service</span>
          <span className="text-xs text-ink-3">Stage</span>
          <span className="text-xs text-ink-3">Type</span>
          <span className="text-right text-xs text-ink-3">Value</span>
        </div>
        <div className="divide-y divide-line">
          {DEMO_ESTIMATES_JOBS.map((row) => (
            <div key={row.id} className="grid grid-cols-[minmax(0,1fr)_140px_130px_90px_110px] items-center gap-6 px-2 py-3.5">
              <span className="truncate text-sm font-medium text-ink">{row.customer}</span>
              <span className="truncate text-sm text-ink-2">{row.service}</span>
              <span>
                <StageBadge label={row.stage} tone={row.stageTone} />
              </span>
              <span className="text-sm text-ink-3">{row.type}</span>
              <span className="text-right text-sm font-semibold tabular-nums text-ink">{formatCurrency(row.value)}</span>
            </div>
          ))}
        </div>
      </div>

      <ul className="divide-y divide-line lg:hidden">
        {DEMO_ESTIMATES_JOBS.map((row) => (
          <li key={row.id} className="px-2 py-3.5">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium text-ink">{row.customer}</span>
              <StageBadge label={row.stage} tone={row.stageTone} />
            </div>
            <div className="mt-0.5 flex items-center justify-between gap-2">
              <span className="truncate text-xs text-ink-3">
                {row.service} · {row.type}
              </span>
              <span className="shrink-0 text-xs font-semibold tabular-nums text-ink">{formatCurrency(row.value)}</span>
            </div>
          </li>
        ))}
      </ul>

      <p className={metaClass}>Quoted/contracted amounts shown here are not collected payments.</p>
    </div>
  );
}

export function DemoGrowthView() {
  return (
    <div className={PAGE_CLASS}>
      <PageHeader eyebrow="Growth" title="Reviews & Referrals" description="Turn completed jobs into reviews, referrals, and repeat business." />

      <DemoMetricStrip items={DEMO_GROWTH_METRICS} />

      <div>
        <p className={sectionLabelClass}>Recent reviews</p>
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {DEMO_REVIEWS.map((review) => (
            <Panel key={review.id}>
              <div className="flex items-center gap-0.5">
                {Array.from({ length: 5 }).map((_, index) => (
                  <Star
                    key={index}
                    className={`h-3.5 w-3.5 ${index < review.rating ? "fill-warning text-warning" : "text-ink-4"}`}
                    aria-hidden
                  />
                ))}
              </div>
              <p className="mt-2.5 text-sm text-ink-2">&ldquo;{review.quote}&rdquo;</p>
              <p className="mt-3 text-xs font-medium text-ink">{review.customer}</p>
              <p className="text-xs text-ink-3">{review.service}</p>
            </Panel>
          ))}
        </div>
      </div>
    </div>
  );
}

export function DemoAutomationsView() {
  return (
    <div className={PAGE_CLASS}>
      <PageHeader
        eyebrow="Automate"
        title="Automations"
        description="The repetitive follow-up work runs in the background while your team handles the conversations that matter."
      />

      <DemoMetricStrip items={DEMO_AUTOMATION_METRICS} />

      <div>
        <p className={sectionLabelClass}>Active automations</p>
        <Panel flush className="mt-3 overflow-hidden">
          <ul className="divide-y divide-line">
            {DEMO_AUTOMATIONS.map((automation) => (
              <li key={automation.id} className="flex items-center gap-3.5 px-4 py-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-muted text-accent">
                  <Workflow className="h-[18px] w-[18px]" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-ink">{automation.name}</p>
                    <Badge tone="success" icon={CheckCircle2}>
                      Active
                    </Badge>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-ink-3">{automation.description}</p>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}
