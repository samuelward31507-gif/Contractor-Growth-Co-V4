import { Users2 } from "lucide-react";
import { EmptyState } from "@/lib/ui/empty-state";
import { AddContactButton } from "./add-contact-button";

export function ContactsEmptyState() {
  return (
    <EmptyState
      icon={Users2}
      title="No contacts yet."
      description="Contacts are the people and customers connected to your business. Add your first contact to start building your directory."
      action={<AddContactButton />}
    />
  );
}
