import Link from "next/link";
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

/**
 * Trackpr 2.0, Phase 3C: the header now reads "Customers" with an "Active
 * leads" badge, rather than a standalone "Leads" identity - per the locked
 * product spec's own mental model ("Lead is a stage on a Customer, never a
 * merged entity" - see app/(app)/customers/[id]/page.tsx's own comment),
 * this page is genuinely a filtered view of the same Customer concept, not
 * a separate product. This component is only ever rendered through the
 * /customers dispatcher now - the literal /leads URL permanently redirects
 * to /customers?from=lead before Next.js would ever resolve this file
 * directly (see next.config.ts) - so there is no remaining real navigation
 * path where a user would see this under a bare "/leads" URL/context.
 * Only the header's copy changed - getLeads/filterLeads/sortLeads, the
 * leads table, and the underlying `leads` table itself are untouched.
 */
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
        title="Customers"
        description="The customers currently in your active sales pipeline."
        badge={<span className="inline-flex items-center rounded-full bg-warning-muted px-2.5 py-0.5 text-xs font-medium text-warning-text">Active leads</span>}
        action={
          <div className="flex items-center gap-4">
            {/* Trackpr 2.0, Phase 3C: the reverse of contacts/page.tsx's own
                new "Active leads" link - a plain path back to the full
                customer directory, not a new route. */}
            <Link
              href="/customers"
              className="rounded text-sm font-medium text-slate-500 transition-colors hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              All customers
            </Link>
            <AddLeadButton contacts={contacts} />
          </div>
        }
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
