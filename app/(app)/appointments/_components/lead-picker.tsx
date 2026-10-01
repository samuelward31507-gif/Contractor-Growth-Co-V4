import { inputClass } from "@/lib/ui/form";
import { STATUS_LABELS } from "@/lib/leads/format";
import type { Lead } from "@/lib/leads/queries";
import { leadPickerDefault } from "@/lib/leads/default-lead";

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
  defaultToNewestOpenLead = false,
  emptyLabel = "No lead (general appointment)",
}: {
  leads: Lead[];
  contactId: string;
  defaultLeadId?: string | null;
  /** Phase 2B: for a NEW estimate or job only - preselect the contact's most recent open lead (lib/leads/default-lead.ts). Ignored when defaultLeadId is given (an existing record keeps its own link, including none). */
  defaultToNewestOpenLead?: boolean;
  /** The blank option's text - appointments keep their original wording; estimates and jobs say "No lead". */
  emptyLabel?: string;
}) {
  if (!contactId) {
    return <p className={`${inputClass} text-ink-3`}>Select a contact first</p>;
  }

  const contactLeads = leads.filter((lead) => lead.contact_id === contactId);

  if (contactLeads.length === 0) {
    return <p className={`${inputClass} text-ink-3`}>No leads for this contact</p>;
  }

  return (
    // Keyed by contact only when defaulting, so picking a different contact
    // re-applies that contact's newest open lead; appointments are unchanged.
    <select
      key={defaultToNewestOpenLead ? contactId : undefined}
      name="leadId"
      defaultValue={leadPickerDefault({ leads: contactLeads, contactId, defaultLeadId, defaultToNewestOpenLead })}
      className={inputClass}
    >
      <option value="">{emptyLabel}</option>
      {contactLeads.map((lead) => (
        <option key={lead.id} value={lead.id}>
          {lead.service ?? "Lead"} · {STATUS_LABELS[lead.status]}
        </option>
      ))}
    </select>
  );
}
