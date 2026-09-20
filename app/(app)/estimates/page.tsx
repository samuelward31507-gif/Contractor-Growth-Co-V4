import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getContacts } from "@/lib/contacts/queries";
import { getLeads } from "@/lib/leads/queries";
import { filterEstimates, getEstimates, summarizeEstimates, type EstimateStatus } from "@/lib/estimates/queries";
import { PageHeader } from "@/lib/ui/page-header";
import { AddEstimateButton } from "./_components/add-estimate-button";
import { EstimatesEmptyState } from "./_components/estimates-empty-state";
import { EstimatesSummary } from "./_components/estimates-summary";
import { EstimatesTable } from "./_components/estimates-table";
import { EstimatesToolbar } from "./_components/estimates-toolbar";

const VALID_STATUSES = new Set<string>(["draft", "sent", "accepted", "declined", "cancelled", "expired"]);

function normalizeStatus(value: string | undefined): EstimateStatus | "all" {
  return value && VALID_STATUSES.has(value) ? (value as EstimateStatus) : "all";
}

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

  const [allEstimates, contacts, leads] = await Promise.all([
    getEstimates(supabase, membership.organizationId),
    getContacts(supabase, membership.organizationId),
    getLeads(supabase, membership.organizationId),
  ]);

  const summary = summarizeEstimates(allEstimates);
  const filtered = filterEstimates(allEstimates, { query, status });
  const hasActiveFilters = Boolean(query.trim()) || status !== "all";

  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <PageHeader
        eyebrow="Operate"
        title="Estimates"
        description="Create, send, and track project estimates."
        action={<AddEstimateButton contacts={contacts} leads={leads} />}
      />

      <EstimatesSummary summary={summary} />

      {allEstimates.length === 0 ? (
        <EstimatesEmptyState contacts={contacts} leads={leads} />
      ) : (
        <div className="border-t border-slate-200 pt-8">
          <EstimatesToolbar initialQuery={query} initialStatus={status} />
          <div className="mt-5">
            <EstimatesTable estimates={filtered} hasActiveFilters={hasActiveFilters} />
          </div>
        </div>
      )}
    </div>
  );
}
