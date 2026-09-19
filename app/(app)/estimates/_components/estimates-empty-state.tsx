import { surfaceClass } from "@/lib/ui/surface";
import type { Contact } from "@/lib/contacts/queries";
import type { Lead } from "@/lib/leads/queries";
import { AddEstimateButton } from "./add-estimate-button";

export function EstimatesEmptyState({ contacts, leads }: { contacts: Contact[]; leads: Lead[] }) {
  return (
    <div className={`${surfaceClass} flex flex-1 items-center justify-center px-6 py-20`}>
      <div className="max-w-sm text-center">
        <h2 className="text-base font-medium text-slate-900">No estimates yet.</h2>
        <p className="mt-1.5 text-sm text-slate-500">
          Once you put together a quote for a customer, it&apos;ll appear here.
        </p>
        <div className="mt-6 flex justify-center">
          <AddEstimateButton contacts={contacts} leads={leads} />
        </div>
      </div>
    </div>
  );
}
