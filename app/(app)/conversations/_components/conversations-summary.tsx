import { sectionLabelClass, statLabelClass, statValueClass } from "@/lib/ui/typography";
import type { ConversationSummary } from "@/lib/conversations/queries";

const STATS: { key: keyof ConversationSummary; label: string }[] = [
  { key: "total", label: "Total conversations" },
  { key: "open", label: "Open" },
  { key: "closed", label: "Closed" },
  { key: "aiEnabled", label: "AI enabled" },
];

export function ConversationsSummary({ summary }: { summary: ConversationSummary }) {
  return (
    <div>
      <p className={sectionLabelClass}>Overview</p>
      <dl className="mt-3 flex flex-wrap gap-x-10 gap-y-4">
        {STATS.map(({ key, label }) => (
          <div key={key}>
            <dt className={statLabelClass}>{label}</dt>
            <dd className={statValueClass}>{summary[key]}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
