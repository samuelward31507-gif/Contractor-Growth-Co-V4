import type { Contact } from "@/lib/contacts/queries";
import type { Lead } from "@/lib/leads/queries";
import { Icon } from "../../_components/icon";
import { AddAppointmentButton } from "./add-appointment-button";

export function AppointmentsEmptyState({ contacts, leads }: { contacts: Contact[]; leads: Lead[] }) {
  return (
    <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white px-6 py-16">
      <div className="max-w-sm text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-500">
          <Icon name="appointments" className="h-6 w-6" />
        </div>
        <h2 className="mt-4 text-base font-semibold text-slate-900">No appointments yet</h2>
        <p className="mt-1.5 text-sm text-slate-500">
          Schedule your first appointment to keep customer visits and calls organized.
        </p>
        <div className="mt-6 flex justify-center">
          <AddAppointmentButton contacts={contacts} leads={leads} />
        </div>
      </div>
    </div>
  );
}
