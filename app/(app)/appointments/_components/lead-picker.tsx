import { inputClass } from "@/lib/ui/form";
import { STATUS_LABELS } from "@/lib/leads/format";
import type { Lead } from "@/lib/leads/queries";

/**
 * Context-aware: only offers leads that belong to the currently selected
 * contact, so a lead can never be attached to the wrong customer from the
 * UI. This filtering is for UX only - the server action independently
 * re-verifies the lead's contact relationship before writing anything.
 */
export function LeadPicker({
  leads,
  contactId,
  defaultLeadId,
}: {
  leads: Lead[];
  contactId: string;
  defaultLeadId?: string | null;
}) {
  if (!contactId) {
    return <p className={`${inputClass} text-slate-400`}>Select a contact first</p>;
  }

  const contactLeads = leads.filter((lead) => lead.contact_id === contactId);

  if (contactLeads.length === 0) {
    return <p className={`${inputClass} text-slate-400`}>No leads for this contact</p>;
  }

  return (
    <select name="leadId" defaultValue={defaultLeadId ?? ""} className={inputClass}>
      <option value="">No lead (general appointment)</option>
      {contactLeads.map((lead) => (
        <option key={lead.id} value={lead.id}>
          {lead.service ?? "Lead"} · {STATUS_LABELS[lead.status]}
        </option>
      ))}
    </select>
  );
}
