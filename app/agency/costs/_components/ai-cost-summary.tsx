import { Bot, CircleHelp, MessageSquare, MessageSquareDashed, Tag } from "lucide-react";
import { StatGrid, StatCard } from "@/lib/ui/stat-card";
import { costValue, countValue } from "./format";
import type { AgencyAiCostTotals, AgencySmsCostTotals } from "@/lib/agency/costs";

const AI_UNAVAILABLE_NOTE = "Unavailable - AI cost data could not be loaded";
const SMS_UNAVAILABLE_NOTE = "Unavailable - SMS cost data could not be loaded";

/**
 * Trackpr Phase 5D-2 - agency-wide AI Cost summary. Known Cost is the only
 * AI dollar figure ever shown - Unpriced/Unknown are always plain counts,
 * never a dollar amount, never $0. Mirrors
 * app/agency/revenue/_components/revenue-summary.tsx's own honesty
 * discipline.
 *
 * Agency redesign: the AI and SMS (Phase 5D-4) totals now sit together in
 * the shared StatGrid as the page's headline - each card keeps its own
 * source (AI from ai_cost_events, SMS from sms_cost_events), and the two are
 * never summed into one figure. A failed read shows "—" for the side that
 * failed, never the placeholder zero its empty result would produce.
 */
export function CostHeadline({
  ai,
  aiUnavailable,
  sms,
  smsUnavailable,
}: {
  ai: AgencyAiCostTotals;
  aiUnavailable: boolean;
  sms: AgencySmsCostTotals;
  smsUnavailable: boolean;
}) {
  return (
    <StatGrid columns={5}>
      <StatCard
        label="Known AI cost"
        value={costValue(ai.knownCost, aiUnavailable)}
        description={aiUnavailable ? AI_UNAVAILABLE_NOTE : `${countValue(ai.knownInteractionCount, false)} interactions with real usage, a trusted provider/model and a matching rate card`}
        tone="success"
        icon={Bot}
      />
      <StatCard
        label="Unpriced AI interactions"
        value={countValue(ai.unpricedInteractionCount, aiUnavailable)}
        description={aiUnavailable ? AI_UNAVAILABLE_NOTE : "Trusted usage, but no rate card covers this period - never shown as $0"}
        tone="warning"
        icon={Tag}
      />
      <StatCard
        label="Unknown AI interactions"
        value={countValue(ai.unknownInteractionCount, aiUnavailable)}
        description={aiUnavailable ? AI_UNAVAILABLE_NOTE : "Usage or provider/model identity could not be established - never shown as $0"}
        icon={CircleHelp}
      />
      <StatCard
        label="Known SMS cost"
        value={costValue(sms.knownCost, smsUnavailable)}
        description={smsUnavailable ? SMS_UNAVAILABLE_NOTE : `${countValue(sms.knownMessageCount, false)} messages with a real Twilio-confirmed price, either direction`}
        tone="success"
        icon={MessageSquare}
      />
      <StatCard
        label="Unknown SMS messages"
        value={countValue(sms.unknownMessageCount, smsUnavailable)}
        description={smsUnavailable ? SMS_UNAVAILABLE_NOTE : "No provider SID, a failed fetch, or a price not yet finalized - never shown as $0"}
        icon={MessageSquareDashed}
      />
    </StatGrid>
  );
}
