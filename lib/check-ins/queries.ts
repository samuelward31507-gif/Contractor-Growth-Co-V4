import type { SupabaseClient } from "@supabase/supabase-js";

export type CheckIn = {
  id: string;
  organization_id: string;
  contact_id: string;
  checked_in_at: string;
  checked_out_at: string | null;
  source: string | null;
  created_at: string;
};

export type CreateCheckInInput = {
  contact_id: string;
  checked_in_at?: string;
  source?: string | null;
};

const CHECK_IN_COLUMNS = "id, organization_id, contact_id, checked_in_at, checked_out_at, source, created_at";

/**
 * Loads recent check-ins for the org, newest first. RLS already scopes rows
 * to the caller's organization; the explicit `organization_id` filter keeps
 * the query efficient and its intent obvious, and never trusts a
 * client-supplied id - same convention as lib/contacts/queries.ts.
 */
export async function getCheckIns(supabase: SupabaseClient, organizationId: string): Promise<CheckIn[]> {
  const { data } = await supabase
    .from("check_ins")
    .select(CHECK_IN_COLUMNS)
    .eq("organization_id", organizationId)
    .order("checked_in_at", { ascending: false })
    .limit(1000);

  return data ?? [];
}

/**
 * Loads check-ins for a single contact, scoped to the org, newest first -
 * the lookup a member profile page's attendance history would need.
 */
export async function getCheckInsForContact(
  supabase: SupabaseClient,
  organizationId: string,
  contactId: string,
): Promise<CheckIn[]> {
  const { data } = await supabase
    .from("check_ins")
    .select(CHECK_IN_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .order("checked_in_at", { ascending: false });

  return data ?? [];
}

/**
 * Creates a check-in scoped to the org. `organization_id` always comes from
 * the server-resolved membership, never from client input.
 * guard_same_organization_contact() (see
 * 20260924100100_memberships_and_check_ins.sql) rejects the insert at the
 * database level if `contact_id` doesn't belong to `organizationId`, so
 * this is defense in depth, not the only check.
 */
export async function createCheckIn(
  supabase: SupabaseClient,
  organizationId: string,
  input: CreateCheckInInput,
): Promise<{ id: string } | null> {
  const { data, error } = await supabase
    .from("check_ins")
    .insert({ ...input, organization_id: organizationId })
    .select("id")
    .single();

  if (error || !data) return null;
  return data;
}
