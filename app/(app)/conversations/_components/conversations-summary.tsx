import { MessageCircle, Archive, Bot } from "lucide-react";
import { sectionLabelClass } from "@/lib/ui/typography";
import { HeroStatRow } from "@/lib/ui/hero-stat-row";
import type { ConversationSummary } from "@/lib/conversations/queries";

/**
 * V2 foundation: brings Conversations in line with the HeroStatRow pattern
 * already used by its sibling list pages (Leads/Appointments/Estimates/
 * Jobs) - this was the one primary list-page overview still on the older
 * flat stat-strip. Open conversations lead as the hero stat (the number
 * that means "look at this first" - unanswered/active threads), matching
 * the same "act now" framing LeadsSummary gives Hot leads.
 */
export function ConversationsSummary({ summary }: { summary: ConversationSummary }) {
  return (
    <div>
      <p className={sectionLabelClass}>Overview</p>
      <div className="mt-3">
        <HeroStatRow
          hero={{ label: "Open", value: summary.open, icon: MessageCircle, tone: "warning" }}
          secondary={[
            { label: "Total conversations", value: summary.total },
            { label: "Closed", value: summary.closed, icon: Archive },
            { label: "AI enabled", value: summary.aiEnabled, icon: Bot },
          ]}
        />
      </div>
    </div>
  );
}
