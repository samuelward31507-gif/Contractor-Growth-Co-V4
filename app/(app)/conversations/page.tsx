import { MessageSquareText } from "lucide-react";
import { EmptyState } from "@/lib/ui/empty-state";

export default function ConversationsIndexPage() {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <EmptyState
        icon={MessageSquareText}
        title="Select a conversation"
        description="Choose a conversation from the list to read the full message history and reply. New activity shows up here as customers text, call, or email in."
      />
    </div>
  );
}
