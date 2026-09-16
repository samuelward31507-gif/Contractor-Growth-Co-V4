import { STATUS_BADGE_CLASS, STATUS_LABELS } from "@/lib/conversations/format";
import type { ConversationStatus } from "@/lib/conversations/queries";

export function ConversationStatusBadge({ status }: { status: ConversationStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_BADGE_CLASS[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}
