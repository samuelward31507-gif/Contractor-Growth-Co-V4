import { Flame } from "lucide-react";
import { EmptyState } from "@/lib/ui/empty-state";
import type { Contact } from "@/lib/contacts/queries";
import { AddLeadButton } from "./add-lead-button";

export function LeadsEmptyState({ contacts }: { contacts: Contact[] }) {
  return (
    <EmptyState
      icon={Flame}
      title="No leads yet."
      description="Once opportunities start coming in, they'll appear here - searchable, sortable, and ready to work."
      action={<AddLeadButton contacts={contacts} />}
    />
  );
}
