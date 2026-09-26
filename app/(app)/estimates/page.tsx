import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertCircle } from "lucide-react";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getContacts } from "@/lib/contacts/queries";
import { getLeads } from "@/lib/leads/queries";
import { filterEstimates, getEstimatesResult, summarizeEstimates, type EstimateStatus } from "@/lib/estimates/queries";
import { PageHeader } from "@/lib/ui/page-header";
import { Panel } from "@/lib/ui/section-card";
import { AddEstimateButton } from "./_components/add-estimate-button";
import { EstimatesEmptyState } from "./_components/estimates-empty-state";
import { EstimatesSummary } from "./_components/estimates-summary";
import { EstimatesTable } from "./_components/estimates-table";
import { EstimatesToolbar } from "./_components/estimates-toolbar";

const VALID_STATUSES = new Set<string>(["draft", "sent", "accepted", "declined", "cancelled", "expired"]);

function normalizeStatus(value: string | undefined): EstimateStatus | "all" {
  return value && VALID_STATUSES.has(value) ? (value as EstimateStatus) : "all";
}

/**
 * Trackpr 2.0, Phase 3E: the header now reads "Estimates & Jobs" with an
 * "Estimates" badge, rather than a standalone "Estimates" identity - the
 * literal /estimates URL permanently redirects to /work?type=estimates
 * (next.config.ts) before Next.js would ever resolve this file directly, so
 * this component is only ever rendered through the /work dispatcher now
 * (same reasoning as Phase 3C/3D's own retitles). Estimates and Jobs remain
 * genuinely distinct data (unlike Schedule's Calendar/Appointments, which
 * showed identical data two ways) - so, like Customers, this reads as one
 * named lifecycle view of the shared "Estimates & Jobs" surface, with a
 * plain link to the other view, not a merged list.
 */
export default async function EstimatesPage({ searchParams }: PageProps<"/estimates">) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : "";
  const status = normalizeStatus(typeof params.status === "string" ? params.status : undefined);

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

  const [estimatesResult, contacts, leads] = await Promise.all([
    getEstimatesResult(supabase, membership.organizationId),
    getContacts(supabase, membership.organizationId),
    getLeads(supabase, membership.organizationId),
  ]);
  const allEstimates = estimatesResult.data;

  const summary = summarizeEstimates(allEstimates);
  const filtered = filterEstimates(allEstimates, { query, status });
  const hasActiveFilters = Boolean(query.trim()) || status !== "all";

  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <PageHeader
        eyebrow="Operate"
        title="Estimates & Jobs"
        description="Create, send, and track project estimates."
        badge={<span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">Estimates</span>}
        action={
          <div className="flex items-center gap-4">
            <Link
              href="/work?type=jobs"
              className="rounded text-sm font-medium text-slate-500 transition-colors hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              View jobs
            </Link>
            <AddEstimateButton contacts={contacts} leads={leads} />
          </div>
        }
      />

      {estimatesResult.failed ? (
        <div className="flex items-start gap-2.5 rounded-lg border border-warning-border bg-warning-muted px-4 py-2.5 text-sm text-warning-text">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>Some information is temporarily unavailable. Please try again.</p>
        </div>
      ) : null}

      <EstimatesSummary summary={summary} />

      {allEstimates.length === 0 ? (
        <EstimatesEmptyState contacts={contacts} leads={leads} />
      ) : (
        <Panel>
          <EstimatesToolbar initialQuery={query} initialStatus={status} />
          <div className="mt-5">
            <EstimatesTable estimates={filtered} hasActiveFilters={hasActiveFilters} />
          </div>
        </Panel>
      )}
    </div>
  );
}
