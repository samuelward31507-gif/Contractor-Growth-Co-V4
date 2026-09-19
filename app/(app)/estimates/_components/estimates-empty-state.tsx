import type { Contact } from "@/lib/contacts/queries";
import type { Lead } from "@/lib/leads/queries";
import { AddEstimateButton } from "./add-estimate-button";

// lib/ui/surface.ts's surfaceClass ("rounded-lg bg-slate-50") is a
// Trackpr 2.0 redesign file that's intentionally never committed this
// phase (see the 65 pre-existing dirty files) - inlined here instead of
// imported so this component doesn't depend on an untracked file.
const surfaceClass = "rounded-lg bg-slate-50";

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
