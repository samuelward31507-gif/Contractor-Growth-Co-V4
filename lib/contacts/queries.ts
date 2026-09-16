import type { SupabaseClient } from "@supabase/supabase-js";

export type Contact = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
  company_name: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

const CONTACT_COLUMNS = "id, first_name, last_name, phone, email, company_name, notes, created_at, updated_at";

/**
 * Loads every contact for the org (capped, matching the dashboard's
 * pattern). RLS already scopes rows to the caller's organization; the
 * explicit `organization_id` filter keeps the query efficient and its
 * intent obvious, and never trusts a client-supplied id.
 */
export async function getContacts(supabase: SupabaseClient, organizationId: string): Promise<Contact[]> {
  const { data } = await supabase
    .from("contacts")
    .select(CONTACT_COLUMNS)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(1000);

  return data ?? [];
}

/**
 * Client-agnostic search over an already-fetched, org-scoped contact list.
 * Matches full name (first + last combined), each name part, phone, email,
 * and company - a plain ilike/or() query can't match a combined full name
 * against separately-stored first/last columns, so this filters in memory
 * over real data rather than issuing a fragile multi-column OR query.
 */
export function filterContacts(contacts: Contact[], query: string): Contact[] {
  const term = query.trim().toLowerCase();
  if (!term) return contacts;

  return contacts.filter((contact) => {
    const fullName = [contact.first_name, contact.last_name].filter(Boolean).join(" ").toLowerCase();
    const haystacks = [
      fullName,
      contact.first_name?.toLowerCase(),
      contact.last_name?.toLowerCase(),
      contact.phone?.toLowerCase(),
      contact.email?.toLowerCase(),
      contact.company_name?.toLowerCase(),
    ];
    return haystacks.some((value) => value?.includes(term));
  });
}

/**
 * Loads a single contact scoped to the org. Any error - including an
 * invalid UUID in `id`, a nonexistent contact, or a contact belonging to a
 * different organization - resolves to `null` rather than throwing, so
 * callers can render a clean "not found" state instead of a crash.
 */
export async function getContact(
  supabase: SupabaseClient,
  organizationId: string,
  id: string,
): Promise<Contact | null> {
  const { data, error } = await supabase
    .from("contacts")
    .select(CONTACT_COLUMNS)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error || !data) return null;
  return data;
}
