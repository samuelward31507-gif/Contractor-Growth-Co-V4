import { sectionLabelClass } from "@/lib/ui/typography";

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
    <div className="mt-8 border-t border-line pt-8">
      <p className={sectionLabelClass}>Unsupported providers</p>
      <p className="mt-1.5 text-xs text-ink-3">These are not costed yet - never shown as $0, never estimated.</p>
      <ul className="mt-3 space-y-2">
        {UNSUPPORTED_PROVIDERS.map((provider) => (
          <li key={provider.name} className="flex items-baseline justify-between gap-4 text-xs">
            <span className="font-medium text-ink-2">{provider.name}</span>
            <span className="text-right text-ink-3">{provider.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
