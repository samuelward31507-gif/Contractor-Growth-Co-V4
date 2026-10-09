import { SectionCard } from "@/lib/ui/section-card";
import { Badge } from "@/lib/ui/badge";

const UNSUPPORTED_PROVIDERS = [
  { name: "Voice", reason: "Trackpr never answers a call today - no billable voice data exists to cost." },
  { name: "n8n", reason: "n8n Cloud's own subscription billing is external information this cost layer does not have." },
  { name: "Vercel", reason: "Shared hosting infrastructure cost - not allocated per client." },
  { name: "Supabase", reason: "Shared database infrastructure cost - not allocated per client." },
  { name: "Email", reason: "Email sends are not currently tracked for usage or cost." },
];

/**
 * Trackpr Phase 5D-2 - explicit, permanent acknowledgment that every
 * provider here is intentionally out of scope, never a $0 standing in for
 * "not costed." Matches the Phase 5D-2 audit's own §9/§13/§7/§8 findings
 * exactly - nothing here is estimated or allocated.
 *
 * Phase 5D-4: SMS/Twilio removed from this list - it now has its own real,
 * authoritative cost section on this page (see sms-cost-summary.tsx).
 */
export function UnsupportedProviders() {
  return (
    <SectionCard title="Unsupported providers" description="These are not costed yet - never shown as $0, never estimated.">
      <ul className="divide-y divide-line">
        {UNSUPPORTED_PROVIDERS.map((provider) => (
          <li key={provider.name} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
            <span className="flex items-center gap-2">
              <span className="text-sm font-medium text-ink">{provider.name}</span>
              <Badge tone="neutral">Not costed</Badge>
            </span>
            <span className="text-xs text-ink-3 sm:text-right">{provider.reason}</span>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
