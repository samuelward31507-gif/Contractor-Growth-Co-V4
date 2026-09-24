import type { SupabaseClient } from "@supabase/supabase-js";

export type MembershipStatus = "active" | "paused" | "cancelled" | "expired";

export type Membership = {
  id: string;
  organization_id: string;
  contact_id: string;
  plan_name: string;
  status: MembershipStatus;
  start_at: string;
  end_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateMembershipInput = {
  contact_id: string;
  plan_name: string;
  status?: MembershipStatus;
  start_at: string;
  end_at?: string | null;
};

const MEMBERSHIP_COLUMNS = "id, organization_id, contact_id, plan_name, status, start_at, end_at, cancelled_at, created_at, updated_at";

/**
 * Loads every membership for the org. RLS already scopes rows to the
 * caller's organization; the explicit `organization_id` filter keeps the
 * query efficient and its intent obvious, and never trusts a
 * client-supplied id - same convention as lib/contacts/queries.ts.
 */
export async function getMemberships(supabase: SupabaseClient, organizationId: string): Promise<Membership[]> {
  const { data } = await supabase
    .from("memberships")
    .select(MEMBERSHIP_COLUMNS)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(1000);

  return data ?? [];
}

/**
 * Loads every membership for a single contact, scoped to the org - the
 * lookup a member profile page would need. Newest first.
 */
export async function getMembershipsForContact(
  supabase: SupabaseClient,
  organizationId: string,
  contactId: string,
): Promise<Membership[]> {
  const { data } = await supabase
    .from("memberships")
    .select(MEMBERSHIP_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false });

  return data ?? [];
}

/**
 * Loads a single membership scoped to the org. Any error - including an
 * invalid UUID, a nonexistent membership, or one belonging to a different
 * organization - resolves to `null` rather than throwing.
 */
export async function getMembership(supabase: SupabaseClient, organizationId: string, id: string): Promise<Membership | null> {
  const { data, error } = await supabase
    .from("memberships")
    .select(MEMBERSHIP_COLUMNS)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error || !data) return null;
  return data;
}

/**
 * Creates a membership scoped to the org. `organization_id` always comes
 * from the server-resolved membership, never from client input.
 * guard_same_organization_contact() (see
 * 20260924100100_memberships_and_check_ins.sql) rejects the insert at the
 * database level if `contact_id` doesn't belong to `organizationId`, so
 * this is defense in depth, not the only check.
 */
export async function createMembership(
  supabase: SupabaseClient,
  organizationId: string,
  input: CreateMembershipInput,
): Promise<{ id: string } | null> {
  const { data, error } = await supabase
    .from("memberships")
    .insert({ ...input, organization_id: organizationId })
    .select("id")
    .single();

  if (error || !data) return null;
  return data;
}
