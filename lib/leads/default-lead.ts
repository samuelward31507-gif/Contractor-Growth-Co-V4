import { OPEN_LEAD_STATUSES, type Lead } from "./queries";

/**
 * Phase 2B (lifecycle attribution): the lead a NEW estimate or job is
 * linked to by default - the contact's most recent open lead (newest
 * created_at among OPEN_LEAD_STATUSES), or null when the contact has none,
 * in which case the picker stays on "No lead". The owner can always change
 * it, including explicitly to "No lead", which the server honors as a blank
 * selection. Never applied to an existing record being edited.
 */
export function newestOpenLeadId(leads: Pick<Lead, "id" | "contact_id" | "status" | "created_at">[], contactId: string): string | null {
  let newest: { id: string; created_at: string } | null = null;
  for (const lead of leads) {
    if (lead.contact_id !== contactId || !OPEN_LEAD_STATUSES.has(lead.status)) continue;
    if (!newest || lead.created_at > newest.created_at) newest = lead;
  }
  return newest?.id ?? null;
}

/**
 * The LeadPicker's initial selection ("" = No lead):
 *   - an existing record (defaultLeadId given, even null) keeps its own link;
 *   - a new estimate or job (defaultToNewestOpenLead) gets the contact's
 *     newest open lead, or "" when there is none;
 *   - anything else (appointments) starts on "", unchanged.
 */
export function leadPickerDefault(input: {
  leads: Pick<Lead, "id" | "contact_id" | "status" | "created_at">[];
  contactId: string;
  defaultLeadId?: string | null;
  defaultToNewestOpenLead?: boolean;
}): string {
  if (input.defaultLeadId !== undefined) return input.defaultLeadId ?? "";
  if (input.defaultToNewestOpenLead) return newestOpenLeadId(input.leads, input.contactId) ?? "";
  return "";
}
