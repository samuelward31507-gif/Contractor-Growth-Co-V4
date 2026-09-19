import { Badge } from "@/lib/ui/badge";
import { STATUS_LABELS } from "@/lib/conversations/format";
import type { ConversationStatus } from "@/lib/conversations/queries";
import { CONVERSATION_STATUS_TONE } from "./status-tone";

/** Thin wrapper around the shared Badge primitive - the one status-pill for the whole app. */
export function ConversationStatusBadge({ status }: { status: ConversationStatus }) {
  return <Badge tone={CONVERSATION_STATUS_TONE[status]}>{STATUS_LABELS[status]}</Badge>;
}
