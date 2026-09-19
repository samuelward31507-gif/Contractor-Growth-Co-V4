import { Inbox } from "lucide-react";
import { EmptyState } from "@/lib/ui/empty-state";

export function ConversationsEmptyState() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <EmptyState
        icon={Inbox}
        title="No conversations yet."
        description="Conversations will appear here once a customer texts, calls, or emails in, or your team logs an interaction with a contact."
      />
    </div>
  );
}
