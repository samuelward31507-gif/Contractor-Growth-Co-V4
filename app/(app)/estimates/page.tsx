import Link from "next/link";
import { redirect } from "next/navigation";
import { getRequestMembership, getRequestSupabase } from "@/lib/auth/request-context";
import { AlertCircle } from "lucide-react";
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
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";

const VALID_STATUSES = new Set<string>(["draft", "sent", "accepted", "declined", "cancelled", "expired"]);

function normalizeStatus(value: string | undefined): EstimateStatus | "all" {
  return value && VALID_STATUSES.has(value) ? (value as EstimateStatus) : "all";
}

/**
 * Nav-restructure pass: Estimates is a real, independent nav destination
 * again (see app/(app)/_components/nav-items.ts's own header comment) - the
 * literal /estimates URL is no longer redirected anywhere, so this file
 * renders directly, under its own name, matching its own nav label exactly
 * (the same "nav label matches page H1" discipline this codebase has used
 * throughout). Estimates and Jobs remain genuinely distinct data, so the
 * cross-link to Jobs stays a plain link to that page's own real URL, not a
 * merged list.
 */
export default async function EstimatesPage({ searchParams }: PageProps<"/estimates">) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : "";
  const status = normalizeStatus(typeof params.status === "string" ? params.status : undefined);

  const supabase = await getRequestSupabase();
  const { user, membership } = await getRequestMembership();

  if (!user) {
    redirect("/login");
  }

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
    <div className={`${PAGE_CONTAINER_CLASS} gap-8 ${PAGE_MAX_WIDTH_CLASS}`}>
      <PageHeader
        eyebrow="Money"
        title="Estimates"
        description="Create, send, and track project estimates."
        action={
          <div className="flex items-center gap-4">
            <Link
              href="/jobs"
              className="inline-flex min-h-11 items-center rounded text-sm font-medium text-ink-3 transition-colors hover:text-ink sm:min-h-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
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
