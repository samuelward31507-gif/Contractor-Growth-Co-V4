import Link from "next/link";
import { Building2 } from "lucide-react";
import { SectionCard } from "@/lib/ui/section-card";
import { EmptyState } from "@/lib/ui/empty-state";
import { Badge } from "@/lib/ui/badge";
import { formatCount } from "../../_components/format";
import { formatNullableCount } from "./format";
import type { CostReadinessSummary } from "@/lib/agency/cost-readiness";

/**
 * Trackpr Phase 5C - Cost Readiness. Purely additive to the Usage page:
 * renders per-client usage-vs-pricing status and the two economics fields
 * (revenue, contribution margin), both always a fixed literal status, never
 * a computed number. No dollar sign appears anywhere in this file.
 *
 * Agency redesign: a SectionCard holding one bordered block per client; the
 * pricing status reads as a neutral Badge. Copy and values are unchanged.
 */

function CategoryRow({ label, usageLine, pricingLabel }: { label: string; usageLine: string; pricingLabel: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">{label}</p>
        <p className="break-words text-xs text-ink-3">{usageLine}</p>
      </div>
      <Badge tone="neutral">{pricingLabel}</Badge>
    </div>
  );
}

function CostReadinessCard({ client }: { client: CostReadinessSummary }) {
  return (
    <div className="rounded-xl border border-line px-4 py-3.5 sm:px-5 sm:py-4">
      <Link href={`/agency/organizations/${client.organizationId}`} className="text-sm font-semibold text-ink hover:underline">
        {client.organizationName}
      </Link>

      <div className="mt-1 divide-y divide-line">
        <CategoryRow
          label="SMS"
          usageLine={`${formatCount(client.messaging.inboundMessages)} in / ${formatCount(client.messaging.outboundMessages)} out`}
          pricingLabel="Cost not configured"
        />
        <CategoryRow
          label="AI"
          usageLine={`${formatCount(client.ai.interactions)} interactions · Input ${formatNullableCount(client.ai.inputTokens)} / Output ${formatNullableCount(client.ai.outputTokens)} / Total ${formatNullableCount(client.ai.totalTokens)} tokens`}
          pricingLabel="Cost not configured"
        />
        <CategoryRow label="Voice" usageLine={`Missed calls: ${formatNullableCount(client.voice.missedCalls)}`} pricingLabel="Cost not configured" />
        <CategoryRow label="Automation" usageLine={`Executions: ${formatCount(client.automation.executions)}`} pricingLabel="Cost not configured" />
      </div>

      <div className="mt-2 border-t border-line pt-3">
        <p className="text-xs font-medium text-ink-3">Economics</p>
        <div className="mt-1.5 flex flex-wrap gap-x-8 gap-y-1">
          <p className="text-xs text-ink-3">
            Revenue{" "}
            <Link href="/agency/revenue" className="ml-1 font-medium text-ink-2 underline decoration-line-strong underline-offset-2 hover:text-ink">
              On the Revenue page
            </Link>
          </p>
          <p className="text-xs text-ink-3">
            Contribution margin <span className="ml-1 font-medium text-ink-2">Unavailable</span>
          </p>
        </div>
      </div>
    </div>
  );
}

export function CostReadinessSection({ clients }: { clients: CostReadinessSummary[] }) {
  return (
    <SectionCard
      title="Cost readiness"
      description="What Trackpr can measure today, and what still needs real provider pricing and revenue data before a cost or margin figure can be shown."
    >
      {clients.length === 0 ? (
        <EmptyState icon={Building2} title="No managed clients yet" description="Once a client organization is connected to the agency, its cost readiness will appear here." />
      ) : (
        <div className="space-y-3">
          {clients.map((client) => (
            <CostReadinessCard key={client.organizationId} client={client} />
          ))}
        </div>
      )}

      <div className="mt-4 rounded-xl bg-inset px-4 py-3.5 sm:px-5 sm:py-4">
        <p className="text-xs font-semibold text-ink-2">About cost data</p>
        <p className="mt-1.5 text-xs text-ink-3">
          Trackpr currently tracks real platform usage — messaging, AI, automation, and missed calls — for every managed client. It does not yet have configured provider
          pricing (Twilio, Anthropic, or automation costs) here, so no dollar cost or margin figure is shown on this page - revenue recorded from Stripe events is on the Revenue page. Usage above is real;
          &ldquo;Cost not configured&rdquo; and &ldquo;Unavailable&rdquo; mean exactly that — never a hidden $0.
        </p>
      </div>
    </SectionCard>
  );
}
