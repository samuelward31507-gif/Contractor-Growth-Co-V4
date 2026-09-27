import Link from "next/link";
import { AlertCircle, ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getAgencyExpansionOpportunities, getAgencyExpansionReadiness, type AgencyExpansionOpportunity } from "@/lib/agency/expansion";
import { sectionLabelClass, metaClass } from "@/lib/ui/typography";
import { PageHeader } from "@/lib/ui/page-header";
import { formatCurrency } from "@/lib/dashboard/format";
import { formatCount } from "../_components/format";
import { UnauthorizedState } from "../_components/unauthorized-state";
import { ErrorState } from "../_components/error-state";
import { Row } from "../_components/row";
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
 */
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
      <div className="mx-auto flex w-full max-w-[1100px] flex-1 flex-col px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
        <ErrorState />
      </div>
    );
  }

  if (!opportunitiesResult.ok || !readinessResult.ok) {
    return (
      <div className="mx-auto flex w-full max-w-[1100px] flex-1 flex-col px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
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

  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
      <Link href="/agency" className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-700">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Agency Command Center
      </Link>

      <div className="mt-3">
        <PageHeader
          eyebrow="Growth"
          title="Expansion Intelligence"
          description="Where a managed client may have an additional service opportunity, based on signals Trackpr already tracks for them."
        />
      </div>

      {/* Mirrors app/agency/page.tsx's own health.partialData banner exactly -
          a real Postgrest error on any one client's opportunities read must
          never silently render this page as if every client were clean. */}
      {partialData ? (
        <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-warning-border bg-warning-muted px-4 py-2.5 text-sm text-warning-text">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>Some opportunity data is temporarily unavailable. The figures below may be incomplete.</p>
        </div>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-3 border-y border-slate-200 py-4">
        <Row label="Clients with opportunities" value={formatCount(summary.organizationsWithOpportunities)} />
        <Row label="Open opportunities" value={formatCount(summary.openOpportunityCount)} />
        <Row label="Known opportunity value" value={formatCurrency(summary.knownOpportunityValue)} />
        <Row label="Unknown-value opportunities" value={formatCount(summary.unknownValueOpportunityCount)} />
        <Row
          label="Process opportunities"
          value={formatCount(summary.contextualOpportunityCount)}
          description="review / referral / follow-through"
        />
      </div>

      <div className="mt-8">
        <div className="flex items-baseline justify-between">
          <p className={sectionLabelClass}>Client opportunities</p>
          {opportunities.length > 0 ? (
            <span className={metaClass}>
              {clientGroups.length} client{clientGroups.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>

        {opportunities.length === 0 ? (
          <div className="mt-4">
            <NoOpportunitiesState />
          </div>
        ) : (
          <div className="mt-2">
            {clientGroups.map((group) => (
              <ClientExpansionCard
                key={group.organizationId}
                organizationId={group.organizationId}
                organizationName={group.organizationName}
                opportunities={group.items}
              />
            ))}
          </div>
        )}
      </div>

      <div className="mt-8 border-t border-slate-200 pt-8">
        <p className={sectionLabelClass}>Client system readiness</p>
        <p className={`mt-1.5 ${metaClass}`}>Real, verified configuration state per client - never a guessed or fabricated connection status.</p>
        {clients.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No managed clients yet.</p>
        ) : (
          <div className="mt-3 divide-y divide-slate-100">
            {clients.map((client) => (
              <ClientReadinessRow key={client.organizationId} client={client} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
