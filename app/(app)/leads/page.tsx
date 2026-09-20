import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getContacts } from "@/lib/contacts/queries";
import {
  filterLeads,
  getLeads,
  summarizeLeads,
  type Lead,
  type LeadStatus,
  type LeadTemperature,
} from "@/lib/leads/queries";
import { PageHeader } from "@/lib/ui/page-header";
import { Panel } from "@/lib/ui/section-card";
import { AddLeadButton } from "./_components/add-lead-button";
import { LeadsEmptyState } from "./_components/leads-empty-state";
import { LeadsSummary } from "./_components/leads-summary";
import { LeadsTable } from "./_components/leads-table";
import { LeadsToolbar } from "./_components/leads-toolbar";

const VALID_STATUSES = new Set<string>(["new", "contacted", "qualified", "appointment", "estimate", "won", "lost"]);
const VALID_TEMPERATURES = new Set<string>(["cold", "warm", "hot"]);

export type LeadSort = "newest" | "oldest" | "value_desc" | "hot_first";
const VALID_SORTS = new Set<string>(["newest", "oldest", "value_desc", "hot_first"]);

function normalizeStatus(value: string | undefined): LeadStatus | "all" {
  return value && VALID_STATUSES.has(value) ? (value as LeadStatus) : "all";
}

function normalizeTemperature(value: string | undefined): LeadTemperature | "all" {
  return value && VALID_TEMPERATURES.has(value) ? (value as LeadTemperature) : "all";
}

function normalizeSort(value: string | undefined): LeadSort {
  return value && VALID_SORTS.has(value) ? (value as LeadSort) : "newest";
}

const TEMPERATURE_RANK: Record<LeadTemperature, number> = { hot: 0, warm: 1, cold: 2 };

/**
 * Presentation-only ordering of an already-fetched, org-scoped lead list -
 * mirrors filterLeads' "filter in memory over real data" pattern rather than
 * adding sort support to lib/leads/queries.ts (out of scope for this pass).
 */
function sortLeads(leads: Lead[], sort: LeadSort): Lead[] {
  const sorted = [...leads];
  switch (sort) {
    case "oldest":
      sorted.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      break;
    case "value_desc":
      sorted.sort((a, b) => (b.estimated_value ?? 0) - (a.estimated_value ?? 0));
      break;
    case "hot_first":
      sorted.sort((a, b) => TEMPERATURE_RANK[a.temperature] - TEMPERATURE_RANK[b.temperature]);
      break;
    case "newest":
    default:
      sorted.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }
  return sorted;
}

export default async function LeadsPage({ searchParams }: PageProps<"/leads">) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : "";
  const status = normalizeStatus(typeof params.status === "string" ? params.status : undefined);
  const temperature = normalizeTemperature(typeof params.temperature === "string" ? params.temperature : undefined);
  const sort = normalizeSort(typeof params.sort === "string" ? params.sort : undefined);

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

  const [allLeads, contacts] = await Promise.all([
    getLeads(supabase, membership.organizationId),
    getContacts(supabase, membership.organizationId),
  ]);

  const summary = summarizeLeads(allLeads);
  const filtered = sortLeads(filterLeads(allLeads, { query, status, temperature }), sort);
  const hasActiveFilters = Boolean(query.trim()) || status !== "all" || temperature !== "all";

  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <PageHeader
        eyebrow="Operate"
        title="Leads"
        description="Manage incoming opportunities and follow-up."
        action={<AddLeadButton contacts={contacts} />}
      />

      <LeadsSummary summary={summary} />

      {allLeads.length === 0 ? (
        <LeadsEmptyState contacts={contacts} />
      ) : (
        <Panel>
          <LeadsToolbar initialQuery={query} initialStatus={status} initialTemperature={temperature} initialSort={sort} />
          <div className="mt-5">
            <LeadsTable leads={filtered} hasActiveFilters={hasActiveFilters} />
          </div>
        </Panel>
      )}
    </div>
  );
}
