import Link from "next/link";
import { sectionLabelClass, metaClass } from "@/lib/ui/typography";
import { formatCount } from "../../_components/format";
import { formatNullableCount } from "./format";
import type { CostReadinessSummary } from "@/lib/agency/cost-readiness";

/**
 * Trackpr Phase 5C - Cost Readiness. Purely additive to the existing Usage
 * page: renders per-client usage-vs-pricing status and the two economics
 * fields (revenue, contribution margin), both always a fixed literal status,
 * never a computed number. No dollar sign appears anywhere in this file.
 */

function CategoryRow({ label, usageLine, pricingLabel }: { label: string; usageLine: string; pricingLabel: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5 py-2.5">
      <div>
        <p className="text-sm font-medium text-ink">{label}</p>
        <p className="text-xs text-ink-3">{usageLine}</p>
      </div>
      <span className="shrink-0 text-xs font-medium text-ink-3">{pricingLabel}</span>
    </div>
  );
}

function CostReadinessCard({ client }: { client: CostReadinessSummary }) {
  return (
    <div className="rounded-lg border border-line px-5 py-4">
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

      <div className="mt-3 border-t border-line pt-3">
        <p className={sectionLabelClass}>Economics</p>
        <div className="mt-1.5 flex flex-wrap gap-x-8 gap-y-1">
          <p className="text-xs text-ink-3">
            Revenue <span className="ml-1 font-medium text-ink-2">Not tracked in Trackpr</span>
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
    <div className="mt-8 border-t border-line pt-8">
      <p className={sectionLabelClass}>Cost readiness</p>
      <p className={`mt-1.5 ${metaClass}`}>What Trackpr can measure today, and what still needs real provider pricing and revenue data before a cost or margin figure can be shown.</p>

      {clients.length === 0 ? (
        <p className="mt-3 text-sm text-ink-3">No managed clients yet.</p>
      ) : (
        <div className="mt-3 space-y-4">
          {clients.map((client) => (
            <CostReadinessCard key={client.organizationId} client={client} />
          ))}
        </div>
      )}

      <div className="mt-6 rounded-lg bg-canvas px-5 py-4">
        <p className="text-xs font-semibold text-ink-3">About cost data</p>
        <p className="mt-1.5 text-xs text-ink-3">
          Trackpr currently tracks real platform usage — messaging, AI, automation, and missed calls — for every managed client. It does not yet have configured provider
          pricing (Twilio, Anthropic, or automation costs) or client revenue data from Stripe, so no dollar cost, revenue, or margin figure is shown. Usage above is real;
          &ldquo;Cost not configured&rdquo; and &ldquo;Unavailable&rdquo; mean exactly that — never a hidden $0.
        </p>
      </div>
    </div>
  );
}
