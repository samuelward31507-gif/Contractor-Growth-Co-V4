import { AlertCircle, Building2, CircleDollarSign, CircleHelp, Lightbulb, MessagesSquare, Users } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getAgencyExpansionOpportunities, getAgencyExpansionReadiness, type AgencyExpansionOpportunity } from "@/lib/agency/expansion";
import { PageHeader } from "@/lib/ui/page-header";
import { StatGrid, StatCard } from "@/lib/ui/stat-card";
import { SectionCard } from "@/lib/ui/section-card";
import { EmptyState } from "@/lib/ui/empty-state";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";
import { formatCurrency } from "@/lib/dashboard/format";
import { formatCount } from "../_components/format";
import { UnauthorizedState } from "../_components/unauthorized-state";
import { ErrorState } from "../_components/error-state";
import { ClientExpansionCard } from "./_components/client-expansion-card";
import { ClientReadinessRow } from "./_components/client-readiness-row";
import { NoOpportunitiesState } from "./_components/no-opportunities-state";

type ClientOpportunityGroup = {
  organizationId: string;
  organizationName: string;
  items: AgencyExpansionOpportunity[];
};

/** Non-contextual known value only - see lib/agency/expansion.ts's CONTEXTUAL_VALUE_TYPES for why a review/referral/follow-through item's value (when present) is never summed as opportunity value. Used only to order clients, highest known opportunity value first. */
function knownValueFor(items: AgencyExpansionOpportunity[]): number {
  return items.reduce((sum, item) => sum + (item.isContextualValue || item.estimatedValue == null ? 0 : item.estimatedValue), 0);
}

/**
 * Trackpr Phase 5A - Agency Expansion Intelligence. A thin, read-only
 * presentation layer over lib/agency/expansion.ts, which itself is a thin
 * aggregation layer over the existing Opportunity Engine and onboarding
 * readiness system - no detection logic, no scoring model, and no dollar
 * figure is computed or invented on this page. Client-side grouping (by
 * organization, then by recommended service within each organization)
 * mirrors app/agency/_components/needs-attention.tsx's own presentation-only
 * grouping exactly - never returned or persisted by the data layer itself.
 *
 * Agency redesign: the client app's page anatomy (standard page container,
 * PageHeader, StatGrid, SectionCards, EmptyState). Reads, grouping, sort,
 * authorization and the error path are unchanged. When a read failed and no
 * opportunities came back, the empty state says the data could not be
 * loaded rather than that there is nothing to find.
 */
const PAGE_CLASS = `${PAGE_CONTAINER_CLASS} gap-8 ${PAGE_MAX_WIDTH_CLASS}`;

export default async function AgencyExpansionPage() {
  const supabase = await createClient();
  const service = createServiceRoleClient();

  let opportunitiesResult: Awaited<ReturnType<typeof getAgencyExpansionOpportunities>>;
  let readinessResult: Awaited<ReturnType<typeof getAgencyExpansionReadiness>>;

  try {
    [opportunitiesResult, readinessResult] = await Promise.all([
      getAgencyExpansionOpportunities(supabase, service),
      getAgencyExpansionReadiness(supabase, service),
    ]);
  } catch {
    return (
      <div className={PAGE_CLASS}>
        <ErrorState />
      </div>
    );
  }

  if (!opportunitiesResult.ok || !readinessResult.ok) {
    return (
      <div className={PAGE_CLASS}>
        <UnauthorizedState />
      </div>
    );
  }

  const { opportunities, summary, partialData } = opportunitiesResult;
  const { clients } = readinessResult;

  const byOrganization = new Map<string, ClientOpportunityGroup>();
  for (const opportunity of opportunities) {
    const existing = byOrganization.get(opportunity.organizationId);
    if (existing) {
      existing.items.push(opportunity);
    } else {
      byOrganization.set(opportunity.organizationId, {
        organizationId: opportunity.organizationId,
        organizationName: opportunity.organizationName,
        items: [opportunity],
      });
    }
  }

  // Highest known opportunity value first, then most open opportunities -
  // the same "what should the agency look at first" ordering
  // ClientExpansionCard already applies to its own service groups.
  const clientGroups = [...byOrganization.values()].sort((a, b) => {
    const knownDiff = knownValueFor(b.items) - knownValueFor(a.items);
    if (knownDiff !== 0) return knownDiff;
    return b.items.length - a.items.length;
  });

  const mayBeIncomplete = "May be incomplete - see the notice above";

  return (
    <div className={PAGE_CLASS}>
      <PageHeader
        eyebrow="Agency"
        title="Expansion"
        description="Where a managed client may have an additional service opportunity, based on signals Trackpr already tracks for them."
      />

      {/* Mirrors app/agency/page.tsx's own health.partialData banner exactly -
          a real Postgrest error on any one client's opportunities read must
          never silently render this page as if every client were clean. */}
      {partialData ? (
        <div role="status" className="flex items-start gap-2.5 rounded-lg border border-warning-border bg-warning-muted px-4 py-2.5 text-sm text-warning-text">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>Some opportunity data is temporarily unavailable. The figures below may be incomplete.</p>
        </div>
      ) : null}

      <StatGrid columns={5}>
        <StatCard
          label="Clients with opportunities"
          value={formatCount(summary.organizationsWithOpportunities)}
          description={partialData ? mayBeIncomplete : "Managed clients with at least one open signal"}
          icon={Users}
        />
        <StatCard label="Open opportunities" value={formatCount(summary.openOpportunityCount)} description={partialData ? mayBeIncomplete : "Across every managed client"} icon={Lightbulb} />
        <StatCard
          label="Known opportunity value"
          value={formatCurrency(summary.knownOpportunityValue)}
          description={partialData ? mayBeIncomplete : "Sum of opportunities that have a value on record"}
          tone="success"
          icon={CircleDollarSign}
        />
        <StatCard
          label="Unknown-value opportunities"
          value={formatCount(summary.unknownValueOpportunityCount)}
          description={partialData ? mayBeIncomplete : "No recorded value, so not in the figure above"}
          icon={CircleHelp}
        />
        <StatCard
          label="Process opportunities"
          value={formatCount(summary.contextualOpportunityCount)}
          description={partialData ? mayBeIncomplete : "Review / referral / follow-through - context only"}
          icon={MessagesSquare}
        />
      </StatGrid>

      <div className="flex flex-col gap-6">
        <SectionCard
          title="Client opportunities"
          description="Highest known value first. Each client links to its full record."
          action={
            opportunities.length > 0 ? (
              <span className="shrink-0 text-xs text-ink-3">
                {clientGroups.length} client{clientGroups.length === 1 ? "" : "s"}
              </span>
            ) : undefined
          }
        >
          {opportunities.length === 0 ? (
            partialData ? (
              <EmptyState
                icon={AlertCircle}
                title="Opportunities couldn't be fully loaded"
                description="No opportunities came back, but at least one client's read failed - so this is not a confirmed empty list. Please try again shortly."
              />
            ) : (
              <NoOpportunitiesState />
            )
          ) : (
            <div className="space-y-3">
              {clientGroups.map((group) => (
                <ClientExpansionCard key={group.organizationId} organizationId={group.organizationId} organizationName={group.organizationName} opportunities={group.items} />
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Client system readiness" description="Real, verified configuration state per client - never a guessed or fabricated connection status.">
          {clients.length === 0 ? (
            <EmptyState icon={Building2} title="No managed clients yet" description="Once a client organization is connected to the agency, its setup readiness will appear here." />
          ) : (
            <ul className="divide-y divide-line">
              {clients.map((client) => (
                <ClientReadinessRow key={client.organizationId} client={client} />
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
