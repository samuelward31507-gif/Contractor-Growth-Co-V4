import { CalendarClock } from "lucide-react";
import { EmptyState } from "@/lib/ui/empty-state";
import type { Contact } from "@/lib/contacts/queries";
import type { Lead } from "@/lib/leads/queries";
import { AddAppointmentButton } from "./add-appointment-button";

export function AppointmentsEmptyState({ contacts, leads }: { contacts: Contact[]; leads: Lead[] }) {
  return (
    <EmptyState
      icon={CalendarClock}
      title="No appointments scheduled."
      description="Schedule your first appointment to keep customer visits and calls organized."
      action={<AddAppointmentButton contacts={contacts} leads={leads} />}
    />
  );
}
