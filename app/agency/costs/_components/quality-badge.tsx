import { Badge, type BadgeTone } from "@/lib/ui/badge";
import type { AiCostDataQuality } from "@/lib/agency/costs";

const QUALITY_LABEL: Record<AiCostDataQuality, string> = {
  known: "Known",
  unknown: "Unknown",
  partial: "Partial",
};

const QUALITY_TONE: Record<AiCostDataQuality, BadgeTone> = {
  known: "success",
  unknown: "neutral",
  partial: "warning",
};

/**
 * Agency redesign: a client's cost data quality (lib/agency/costs.ts's
 * dataQualityFor - same three states, same labels as before) as the shared
 * Badge. When the read failed the quality was computed from placeholder
 * counts, so it reads "Unavailable" instead.
 */
export function QualityBadge({ quality, unavailable }: { quality: AiCostDataQuality; unavailable: boolean }) {
  if (unavailable) return <Badge tone="neutral">Unavailable</Badge>;
  return <Badge tone={QUALITY_TONE[quality]}>{QUALITY_LABEL[quality]}</Badge>;
}
