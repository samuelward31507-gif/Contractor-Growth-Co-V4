import { Users2 } from "lucide-react";
import { EmptyState } from "@/lib/ui/empty-state";
import { AddContactButton } from "@/app/(app)/contacts/_components/add-contact-button";

/** Reuses AddContactButton/ContactDialog as-is - creating a person is the same action regardless of which list route it's launched from, so this isn't a new form, just a new entry point onto the existing one. */
export function PeopleEmptyState() {
  return (
    <EmptyState
      icon={Users2}
      title="No one yet."
      description="People are everyone your business is currently working with or has worked with. Add your first person to start building your directory."
      action={<AddContactButton />}
    />
  );
}
