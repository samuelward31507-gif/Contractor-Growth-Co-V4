import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertCircle } from "lucide-react";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getContacts } from "@/lib/contacts/queries";
import { getLeads } from "@/lib/leads/queries";
import { filterEstimates, getEstimatesResult, summarizeEstimates, ESTIMATE_STATUSES, type EstimateStatus } from "@/lib/estimates/queries";
import { filterJobs, getJobsResult, summarizeJobs, JOB_STATUSES, type JobStatus } from "@/lib/jobs/queries";
import { formatCurrency } from "@/lib/dashboard/format";
import { computeMoneySnapshot, type MoneyEntry } from "@/lib/money/snapshot";
import { pageTitleClass, pageDescriptionClass, sectionLabelClass } from "@/lib/ui/typography";
import { MoneyEntriesTable } from "./_components/money-entries-table";
import { StatGrid, StatCard } from "@/lib/ui/stat-card";
import { Panel } from "@/lib/ui/section-card";
import { Wallet, CalendarClock, Hammer, TrendingUp } from "lucide-react";
import { AddEstimateButton } from "../estimates/_components/add-estimate-button";
import { EstimatesEmptyState } from "../estimates/_components/estimates-empty-state";
import { EstimatesSummary } from "../estimates/_components/estimates-summary";
import { EstimatesTable } from "../estimates/_components/estimates-table";
import { EstimatesToolbar } from "../estimates/_components/estimates-toolbar";
import { AddJobButton } from "../jobs/_components/add-job-button";
import { JobsEmptyState } from "../jobs/_components/jobs-empty-state";
import { JobsSummary } from "../jobs/_components/jobs-summary";
import { JobsTable } from "../jobs/_components/jobs-table";
import { JobsToolbar } from "../jobs/_components/jobs-toolbar";
import { MoneyTabs, type MoneyTab } from "./_components/money-tabs";
import { getInvoicesResult, getCustomerPaymentsResult } from "@/lib/invoices/queries";
import { filterInvoices, summarizeInvoiceMoney } from "@/lib/invoices/summary";
import { calendarDateInTimeZone, INVOICE_STATUSES, type InvoiceStatus } from "@/lib/invoices/domain";
import { getOrganizationTimezone } from "@/lib/settings/queries";
import { InvoiceMoneySummaryCards } from "../invoices/_components/invoice-money-summary";
import { InvoicesTable } from "../invoices/_components/invoices-table";
import { InvoicesToolbar } from "../invoices/_components/invoices-toolbar";

function totalsLine(entries: MoneyEntry[]): string {
  if (entries.length === 0) return "";
  const known = entries.filter((entry) => entry.amount > 0);
  const total = known.reduce((sum, entry) => sum + entry.amount, 0);
  const unknownCount = entries.length - known.length;
  const countLabel = `${entries.length} ${entries.length === 1 ? "item" : "items"}`;
  if (known.length === 0) return `${countLabel} · value unknown`;
  const suffix = unknownCount > 0 ? ` (${unknownCount} with no amount set)` : "";
  return `${formatCurrency(total)} across ${countLabel}${suffix}`;
}

function normalizeBrowse(value: string | undefined): MoneyTab {
  if (value === "estimates") return "estimates";
  if (value === "jobs") return "jobs";
  if (value === "invoices") return "invoices";
  return "money";
}

function normalizeInvoiceStatus(value: string | undefined): InvoiceStatus | "all" | "overdue" {
  if (value === "overdue") return "overdue";
  return value && (INVOICE_STATUSES as readonly string[]).includes(value) ? (value as InvoiceStatus) : "all";
}

function normalizeEstimateStatus(value: string | undefined): EstimateStatus | "all" {
  return value && ESTIMATE_STATUSES.some((s) => s.value === value) ? (value as EstimateStatus) : "all";
}

function normalizeJobStatus(value: string | undefined): JobStatus | "all" {
  return value && JOB_STATUSES.some((s) => s.value === value) ? (value as JobStatus) : "all";
}

/**
 * IA consolidation pass: Money absorbs Work in full - the curated "Money"
 * view (Quotes out / Ready to schedule / Won not finished) is still the
 * default, but "All estimates"/"All jobs" (MoneyTabs) now reuse Work's own
 * EstimatesTable/JobsTable/toolbars/summaries/Add buttons/empty states
 * verbatim, so nothing Work could do - browsing every estimate or job
 * regardless of status, searching, filtering, creating a new one - is lost
 * by retiring /work as a separate destination (see its own page.tsx, now a
 * redirect here). "Ready to schedule" (an accepted estimate with no job
 * yet) is the one real signal Work's old "Needs to move" queue carried that
 * neither of Money's original two groups covered - added here rather than
 * dropped. The fourth "Needs to move" bucket (a completed job with no
 * review request sent) is not carried over: per lib/reviews-referrals' own
 * documentation this state is never actually observed in practice (review
 * requests are created automatically on job completion), and the concept
 * itself belongs to Reviews & Referrals, not Money.
 */
export default async function MoneyPage({ searchParams }: PageProps<"/money">) {
  const params = await searchParams;
  const browse = normalizeBrowse(typeof params.browse === "string" ? params.browse : undefined);
  const query = typeof params.q === "string" ? params.q : "";
  const estimateStatus = normalizeEstimateStatus(typeof params.status === "string" ? params.status : undefined);
  const jobStatus = normalizeJobStatus(typeof params.status === "string" ? params.status : undefined);
  const invoiceStatus = normalizeInvoiceStatus(typeof params.status === "string" ? params.status : undefined);

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const membership = await getUserOrganization(supabase, user.id);
  if (!membership) {
    redirect("/onboarding");
  }

  const [estimatesResult, jobsResult, contacts, leads, invoicesResult, paymentsResult, timeZone] = await Promise.all([
    getEstimatesResult(supabase, membership.organizationId),
    getJobsResult(supabase, membership.organizationId),
    getContacts(supabase, membership.organizationId),
    getLeads(supabase, membership.organizationId),
    // Phase 1B-3: invoices and the customer_payments ledger, the only
    // source "Collected" may ever be computed from.
    getInvoicesResult(supabase, membership.organizationId),
    getCustomerPaymentsResult(supabase, membership.organizationId),
    getOrganizationTimezone(supabase, membership.organizationId),
  ]);
  const allEstimates = estimatesResult.data;
  const allJobs = jobsResult.data;
  const allInvoices = invoicesResult.data;
  const failed = estimatesResult.failed || jobsResult.failed || invoicesResult.failed || paymentsResult.failed;
  const today = calendarDateInTimeZone(new Date(), timeZone ?? "UTC");
  const invoiceSummary = summarizeInvoiceMoney({ invoices: allInvoices, payments: paymentsResult.data, jobs: allJobs, today });
  const filteredInvoices = filterInvoices(allInvoices, { query, status: invoiceStatus }, today);
  const hasActiveInvoiceFilters = Boolean(query.trim()) || invoiceStatus !== "all";

  const { quotesOut, readyToSchedule, wonNotFinished, knownOpportunityValue } = computeMoneySnapshot(allEstimates, allJobs);

  const estimateSummary = summarizeEstimates(allEstimates);
  const jobSummary = summarizeJobs(allJobs);
  const filteredEstimates = filterEstimates(allEstimates, { query, status: estimateStatus });
  const hasActiveEstimateFilters = Boolean(query.trim()) || estimateStatus !== "all";
  const filteredJobs = filterJobs(allJobs, { query, status: jobStatus });
  const hasActiveJobFilters = Boolean(query.trim()) || jobStatus !== "all";

  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className={pageTitleClass}>Money</h1>
          <p className={`mt-1.5 ${pageDescriptionClass}`}>
            {browse === "money"
              ? "What's out for a decision, what's ready to schedule, what's already won but not finished, and what's been billed and collected."
              : browse === "invoices"
                ? "Every invoice, with what has been collected against it. Invoices are created from a job."
                : "Every estimate and job, searchable and filterable."}
          </p>
        </div>
        {browse === "jobs" || browse === "estimates" ? (
          <div className="shrink-0">{browse === "jobs" ? <AddJobButton contacts={contacts} leads={leads} /> : <AddEstimateButton contacts={contacts} leads={leads} />}</div>
        ) : null}
      </div>

      {failed ? (
        <div className="flex items-start gap-2.5 rounded-lg border border-warning-border bg-warning-muted px-4 py-2.5 text-sm text-warning-text">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>Some information is temporarily unavailable. Please try again.</p>
        </div>
      ) : null}

      <MoneyTabs active={browse} />

      {browse === "money" ? (
        <>
          <StatGrid columns={4}>
            <StatCard label="Quotes out" value={quotesOut.length} description={totalsLine(quotesOut) || "Nothing out right now"} icon={Wallet} />
            <StatCard label="Ready to schedule" value={readyToSchedule.length} description={totalsLine(readyToSchedule) || "Nothing waiting"} tone="danger" icon={CalendarClock} />
            <StatCard label="Jobs in progress" value={wonNotFinished.length} description={totalsLine(wonNotFinished) || "Nothing in progress"} tone="success" icon={Hammer} />
            <StatCard label="Known opportunity value" value={formatCurrency(knownOpportunityValue)} description="Across every quote, accepted job, and job in progress" icon={TrendingUp} />
          </StatGrid>

          <div>
            <p className={sectionLabelClass}>Invoices &amp; payments</p>
            <p className="mt-1 text-xs text-slate-500">Invoiced and outstanding are amounts asked for. Collected is money actually received - the only figure here that is.</p>
            <div className="mt-3">
              <InvoiceMoneySummaryCards summary={invoiceSummary} />
            </div>
          </div>

          <div>
            <p className={sectionLabelClass}>Quotes out</p>
            <MoneyEntriesTable entries={quotesOut} emptyMessage="No quotes are out right now." />
          </div>

          <div>
            <p className={sectionLabelClass}>Ready to schedule</p>
            <MoneyEntriesTable entries={readyToSchedule} emptyMessage="Nothing accepted and waiting on a job." />
          </div>

          <div>
            <p className={sectionLabelClass}>Won, not finished</p>
            <MoneyEntriesTable entries={wonNotFinished} emptyMessage="No jobs in progress right now." />
          </div>
        </>
      ) : null}

      {browse === "invoices" ? (
        <>
          <InvoiceMoneySummaryCards summary={invoiceSummary} />
          {allInvoices.length === 0 ? (
            <Panel>
              <p className="text-sm font-semibold text-slate-900">No invoices yet</p>
              <p className="mt-1 text-sm text-slate-500">Open a job and choose Create invoice. It starts as a draft you can review before issuing.</p>
              <Link href="/money?browse=jobs&status=completed" className="mt-3 inline-block text-sm font-medium text-slate-900 hover:underline">
                See completed jobs
              </Link>
            </Panel>
          ) : (
            <Panel>
              <InvoicesToolbar initialQuery={query} initialStatus={invoiceStatus} extraParams={{ browse: "invoices" }} />
              <div className="mt-5">
                <InvoicesTable invoices={filteredInvoices} hasActiveFilters={hasActiveInvoiceFilters} today={today} />
              </div>
            </Panel>
          )}
        </>
      ) : null}

      {browse === "estimates" ? (
        <>
          <EstimatesSummary summary={estimateSummary} />
          {allEstimates.length === 0 ? (
            <EstimatesEmptyState contacts={contacts} leads={leads} />
          ) : (
            <Panel>
              <EstimatesToolbar initialQuery={query} initialStatus={estimateStatus} extraParams={{ browse: "estimates" }} />
              <div className="mt-5">
                <EstimatesTable estimates={filteredEstimates} hasActiveFilters={hasActiveEstimateFilters} />
              </div>
            </Panel>
          )}
        </>
      ) : null}

      {browse === "jobs" ? (
        <>
          <JobsSummary summary={jobSummary} />
          {allJobs.length === 0 ? (
            <JobsEmptyState contacts={contacts} leads={leads} />
          ) : (
            <Panel>
              <JobsToolbar initialQuery={query} initialStatus={jobStatus} extraParams={{ browse: "jobs" }} />
              <div className="mt-5">
                <JobsTable jobs={filteredJobs} hasActiveFilters={hasActiveJobFilters} />
              </div>
            </Panel>
          )}
        </>
      ) : null}
    </div>
  );
}
