import type { Contact } from "@/lib/contacts/queries";
import { Icon } from "../../_components/icon";
import { AddLeadButton } from "./add-lead-button";

export function LeadsEmptyState({ contacts }: { contacts: Contact[] }) {
  return (
    <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white px-6 py-16">
      <div className="max-w-sm text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-500">
          <Icon name="leads" className="h-6 w-6" />
        </div>
        <h2 className="mt-4 text-base font-semibold text-slate-900">No leads yet</h2>
        <p className="mt-1.5 text-sm text-slate-500">
          Leads are opportunities connected to your contacts. Add your first lead to start
          tracking potential jobs.
        </p>
        <div className="mt-6 flex justify-center">
          <AddLeadButton contacts={contacts} />
        </div>
      </div>
    </div>
  );
}
