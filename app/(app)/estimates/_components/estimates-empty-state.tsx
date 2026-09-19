import { FileText } from "lucide-react";
import { EmptyState } from "@/lib/ui/empty-state";
import type { Contact } from "@/lib/contacts/queries";
import type { Lead } from "@/lib/leads/queries";
import { AddEstimateButton } from "./add-estimate-button";

export function EstimatesEmptyState({ contacts, leads }: { contacts: Contact[]; leads: Lead[] }) {
  return (
    <EmptyState
      icon={FileText}
      title="No estimates yet."
      description="Once you put together a quote for a customer, it'll appear here."
      action={<AddEstimateButton contacts={contacts} leads={leads} />}
    />
  );
}
