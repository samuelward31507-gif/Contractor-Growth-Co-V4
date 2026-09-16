import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getContacts } from "@/lib/contacts/queries";
import {
  filterLeads,
  getLeads,
  summarizeLeads,
  type LeadStatus,
  type LeadTemperature,
} from "@/lib/leads/queries";
import { AddLeadButton } from "./_components/add-lead-button";
import { LeadsEmptyState } from "./_components/leads-empty-state";
import { LeadsSummary } from "./_components/leads-summary";
import { LeadsTable } from "./_components/leads-table";
import { LeadsToolbar } from "./_components/leads-toolbar";

const VALID_STATUSES = new Set<string>(["new", "contacted", "qualified", "appointment", "estimate", "won", "lost"]);
const VALID_TEMPERATURES = new Set<string>(["cold", "warm", "hot"]);

function normalizeStatus(value: string | undefined): LeadStatus | "all" {
  return value && VALID_STATUSES.has(value) ? (value as LeadStatus) : "all";
}

function normalizeTemperature(value: string | undefined): LeadTemperature | "all" {
  return value && VALID_TEMPERATURES.has(value) ? (value as LeadTemperature) : "all";
}

export default async function LeadsPage({ searchParams }: PageProps<"/leads">) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : "";
  const status = normalizeStatus(typeof params.status === "string" ? params.status : undefined);
  const temperature = normalizeTemperature(typeof params.temperature === "string" ? params.temperature : undefined);

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
  const filtered = filterLeads(allLeads, { query, status, temperature });
  const hasActiveFilters = Boolean(query.trim()) || status !== "all" || temperature !== "all";

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Leads</h1>
          <p className="mt-1 text-sm text-slate-500">
            Track every opportunity from first inquiry to closed job.
          </p>
        </div>
        <AddLeadButton contacts={contacts} />
      </div>

      <LeadsSummary summary={summary} />

      {allLeads.length === 0 ? (
        <LeadsEmptyState contacts={contacts} />
      ) : (
        <>
          <LeadsToolbar initialQuery={query} initialStatus={status} initialTemperature={temperature} />
          <LeadsTable leads={filtered} hasActiveFilters={hasActiveFilters} />
        </>
      )}
    </div>
  );
}
