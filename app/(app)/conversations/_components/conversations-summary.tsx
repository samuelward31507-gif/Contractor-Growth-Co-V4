import { cardClass } from "@/lib/ui/card";
import type { ConversationSummary } from "@/lib/conversations/queries";

const CARDS: { key: keyof ConversationSummary; label: string }[] = [
  { key: "total", label: "Total Conversations" },
  { key: "open", label: "Open" },
  { key: "closed", label: "Closed" },
  { key: "aiEnabled", label: "AI Enabled" },
];

export function ConversationsSummary({ summary }: { summary: ConversationSummary }) {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {CARDS.map(({ key, label }) => (
        <div key={key} className={`${cardClass} p-5`}>
          <p className="text-sm text-slate-500">{label}</p>
          <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">{summary[key]}</p>
        </div>
      ))}
    </div>
  );
}
